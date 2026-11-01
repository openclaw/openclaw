import type { ServerResponse } from "node:http";
import { attachModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { DecisionBatchV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildClawRouterDecisionProvider } from "./decision-provider.js";

const batch: DecisionBatchV2 = {
  state: { type: "text", text: "Only supplied evidence" },
  questions: { q: { type: "boolean" } },
};
const reply = {
  model: "gpt-6-luna",
  answers: [{ name: "q", type: "predicate", probability: 0.75 }],
  usage: { input_tokens: 4, output_tokens: 0 },
};
function catalog() {
  return {
    providers: [
      {
        id: "openai",
        nativeBaseUrl: "/v1/native/openai",
        routes: [{ path: "/v1/decisions", methods: ["POST"], requestFormat: "openai.decisions" }],
        models: [
          { id: "openai/gpt-6-luna", upstream: "gpt-6-luna", capabilities: ["llm.decisions"] },
        ],
      },
    ],
  };
}
function context(
  baseUrl: string,
  extra: Partial<DecisionProviderContextV2> = {},
): DecisionProviderContextV2 {
  return {
    model: attachModelProviderRequestTransport(
      {
        provider: "clawrouter",
        id: "openai/gpt-6-luna",
        name: "Luna",
        api: "openai-responses",
        baseUrl,
      },
      { allowPrivateNetwork: true },
    ),
    auth: { mode: "api-key", apiKey: "synthetic-router-key" },
    config: {},
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 5000,
    isAdmissible: () => true,
    ...extra,
  };
}
type Seen = {
  path: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};
async function fixture(
  run: (origin: string, seen: Seen[]) => Promise<void>,
  respond: (path: string | undefined, response: ServerResponse, seen: Seen) => void = (
    path,
    response,
  ) => response.end(JSON.stringify(path === "/v1/catalog" ? catalog() : reply)),
) {
  const seen: Seen[] = [];
  await withServer(
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const entry = {
          path: request.url,
          headers: request.headers,
          body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
        };
        seen.push(entry);
        response.setHeader("content-type", "application/json");
        respond(request.url, response, entry);
      });
    },
    (origin) => run(origin, seen),
  );
}
const evaluate = (origin: string, extra: Partial<DecisionProviderContextV2> = {}, input = batch) =>
  buildClawRouterDecisionProvider().evaluate(input, context(origin, extra));
beforeEach(() => {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    vi.stubEnv(key, undefined);
    vi.stubEnv(key.toLowerCase(), undefined);
  }
  vi.stubEnv("OPENAI_API_KEY", "synthetic-never-upstream");
});
afterEach(() => vi.unstubAllEnvs());

it("uses the selected router credential and effective route without upstream key discovery", async () => {
  await fixture(async (origin, seen) => {
    expect(await evaluate(origin + "/v1")).toMatchObject({
      status: "ok",
      result: {
        answers: { q: { probabilityTrue: 0.75 } },
        usage: { inputTokens: 4, outputTokens: 0 },
      },
    });
    expect(seen).toHaveLength(2);
    expect(seen.map(({ path, headers }) => [path, headers.authorization])).toEqual([
      ["/v1/catalog", "Bearer synthetic-router-key"],
      ["/v1/native/openai/v1/decisions", "Bearer synthetic-router-key"],
    ]);
    expect(seen[1]?.body).toEqual({
      model: "gpt-6-luna",
      input: "Only supplied evidence",
      questions: [{ name: "q", type: "predicate", instructions: "" }],
    });
  });
});

it("does not discover upstream OpenAI credentials when router auth is absent", async () => {
  await fixture(async (origin, seen) => {
    expect(await evaluate(origin, { auth: { mode: "api-key" } })).toEqual({
      status: "unavailable",
      reason: "credentials-unavailable",
    });
    expect(seen).toEqual([]);
  });
});

it("uses prepared replacement auth for both catalog and inference and rejects reflected replacement bytes", async () => {
  await fixture(
    async (origin, seen) => {
      const model = attachModelProviderRequestTransport(
        { ...context(origin).model, headers: { "X-Credential": "synthetic-override" } },
        {
          allowPrivateNetwork: true,
          auth: { mode: "header", headerName: "X-Credential", value: "synthetic-override" },
        },
      );
      expect(await evaluate(origin, { model })).toEqual({
        status: "unavailable",
        reason: "invalid-response",
      });
      expect(seen).toHaveLength(2);
      for (const { headers } of seen) {
        expect(headers.authorization).toBeUndefined();
        expect(headers["x-credential"]).toBe("synthetic-override");
      }
    },
    (path, response) =>
      response.end(
        JSON.stringify(
          path === "/v1/catalog" ? catalog() : { ...reply, model: "synthetic-override" },
        ),
      ),
  );
});

it("never shares a catalog grant across keys or endpoints, including interleaved callers", async () => {
  await fixture(
    async (origin, seen) => {
      await fixture(
        async (other, otherSeen) => {
          const outcomes = await Promise.all([
            evaluate(origin),
            evaluate(origin, { auth: { mode: "api-key", apiKey: "synthetic-denied" } }),
            evaluate(other),
          ]);
          expect(outcomes.map(({ status }) => status)).toEqual([
            "ok",
            "unavailable",
            "unavailable",
          ]);
          expect(seen.filter(({ path }) => path === "/v1/catalog")).toHaveLength(2);
          expect(seen.filter(({ path }) => path?.endsWith("/decisions"))).toHaveLength(1);
          expect(otherSeen.map(({ path }) => path)).toEqual(["/v1/catalog"]);
        },
        (_path, response) => response.end(JSON.stringify({ providers: [] })),
      );
    },
    (path, response, seen) =>
      response.end(
        JSON.stringify(
          path === "/v1/catalog"
            ? seen.headers.authorization === "Bearer synthetic-denied"
              ? { providers: [] }
              : catalog()
            : reply,
        ),
      ),
  );
});

it.each(["route", "capability", "alias"] as const)(
  "requires the key catalog's exact native %s contract",
  async (missing) => {
    const body = catalog();
    if (missing === "route") {
      body.providers[0]!.routes = [];
    }
    if (missing === "capability") {
      body.providers[0]!.models[0]!.capabilities = ["llm.chat"];
    }
    if (missing === "alias") {
      body.providers[0]!.models[0]!.upstream = "another-model";
    }
    await fixture(
      async (origin, seen) => {
        expect(await evaluate(origin)).toEqual({
          status: "unavailable",
          reason: "unsupported-input",
        });
        expect(seen.map(({ path }) => path)).toEqual(["/v1/catalog"]);
      },
      (_path, response) => response.end(JSON.stringify(body)),
    );
  },
);

it.each(["/v1/catalog", "/v1/native/openai/v1/decisions"])(
  "maps HTTP failures at %s without retry or body disclosure",
  async (failedPath) => {
    for (const [status, reason] of [
      [401, "authentication"],
      [403, "authentication"],
      [429, "rate-limited"],
    ] as const) {
      await fixture(
        async (origin, seen) => {
          expect(await evaluate(origin)).toEqual({
            status: "unavailable",
            reason,
            ...(status === 429 ? { retryAfterMs: 2000 } : {}),
          });
          expect(seen.map(({ path }) => path)).toEqual(
            failedPath === "/v1/catalog" ? [failedPath] : ["/v1/catalog", failedPath],
          );
        },
        (path, response) => {
          if (path === failedPath) {
            response.statusCode = status;
            response.setHeader("retry-after", "2");
            response.end("synthetic-router-key private evidence");
          } else {
            response.end(JSON.stringify(catalog()));
          }
        },
      );
    }
  },
);

it.each(["/v1/catalog", "/v1/native/openai/v1/decisions"])(
  "rejects malformed and credential-reflecting JSON at %s",
  async (failedPath) => {
    for (const invalid of [
      "not JSON",
      JSON.stringify({
        ...(failedPath === "/v1/catalog" ? catalog() : reply),
        reflected: "synthetic-router-key",
      }),
    ]) {
      await fixture(
        async (origin, seen) => {
          expect(await evaluate(origin)).toEqual({
            status: "unavailable",
            reason: "invalid-response",
          });
          expect(seen.at(-1)?.path).toBe(failedPath);
        },
        (path, response) => response.end(path === failedPath ? invalid : JSON.stringify(catalog())),
      );
    }
  },
);

it.each(["image/png", "image/jpeg", "image/webp"])(
  "inlines %s and only explicitly supplied text",
  async (mime) => {
    await fixture(async (origin, seen) => {
      expect(
        (
          await evaluate(
            origin,
            { reasoning: "auto" },
            {
              ...batch,
              state: { type: "image", dataUri: `data:${mime};base64,AA==`, text: "Inspect this" },
            },
          )
        ).status,
      ).toBe("ok");
      expect(seen[1]?.body).toEqual({
        model: "gpt-6-luna",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Inspect this" },
              { type: "input_image", image_url: `data:${mime};base64,AA==` },
            ],
          },
        ],
        questions: [{ name: "q", type: "predicate", instructions: "" }],
      });
    });
  },
);

it.each([201, 400])(
  "dispatches all %i questions through the native router route",
  async (count) => {
    const names = Array.from({ length: count }, (_, index) => `q${index}`);
    await fixture(
      async (origin, seen) => {
        const outcome = await evaluate(
          origin,
          {},
          {
            ...batch,
            questions: Object.fromEntries(names.map((name) => [name, { type: "boolean" }])),
          },
        );
        expect(outcome).toMatchObject({ status: "ok" });
        if (outcome.status === "ok") {
          expect(Object.keys(outcome.result.answers)).toEqual(names);
          expect(Object.values(outcome.result.answers)).toEqual(
            names.map(() => ({ type: "boolean", probabilityTrue: 0.75 })),
          );
        }
        expect(seen.map(({ path }) => path)).toEqual([
          "/v1/catalog",
          "/v1/native/openai/v1/decisions",
        ]);
        expect(seen[1]?.body).toEqual({
          model: "gpt-6-luna",
          input: "Only supplied evidence",
          questions: names.map((name) => ({ name, type: "predicate", instructions: "" })),
        });
      },
      (path, response) =>
        response.end(
          JSON.stringify(
            path === "/v1/catalog"
              ? catalog()
              : {
                  ...reply,
                  answers: names.map((name) => ({ name, type: "predicate", probability: 0.75 })),
                },
          ),
        ),
    );
  },
);

it("rejects unsupported reasoning, image size, and question/choice counts before catalog I/O", async () => {
  await fixture(async (origin, seen) => {
    for (const reasoning of ["on", "off"] as const) {
      expect(await evaluate(origin, { reasoning })).toEqual({
        status: "unavailable",
        reason: "unsupported-input",
      });
    }
    const oversized: DecisionBatchV2 = {
      ...batch,
      state: {
        type: "image",
        dataUri: "data:image/png;base64," + Buffer.alloc(4_194_305).toString("base64"),
      },
    };
    expect(await evaluate(origin, {}, oversized)).toEqual({
      status: "unavailable",
      reason: "unsupported-input",
    });
    expect(
      await evaluate(
        origin,
        {},
        {
          ...batch,
          questions: Object.fromEntries(
            Array.from({ length: 401 }, (_, index) => ["q" + index, { type: "boolean" }]),
          ),
        },
      ),
    ).toEqual({ status: "unavailable", reason: "unsupported-input" });
    expect(
      await evaluate(
        origin,
        {},
        {
          ...batch,
          questions: {
            q: {
              type: "choice",
              criteria: Object.fromEntries(
                Array.from({ length: 256 }, (_, index) => ["o" + index, "criterion"]),
              ),
            },
          },
        },
      ),
    ).toEqual({ status: "unavailable", reason: "unsupported-input" });
    expect(seen).toEqual([]);
  });
});

it.each(["/v1/catalog", "/v1/native/openai/v1/decisions"])(
  "aborts a held %s response and closes its transport",
  async (heldPath) => {
    const received = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const controller = new AbortController();
    await fixture(
      async (origin, seen) => {
        const pending = evaluate(origin, { signal: controller.signal });
        const rejected = expect(pending).rejects.toThrow("caller cancelled");
        await Promise.race([received.promise, pending]);
        controller.abort(new Error("caller cancelled"));
        await rejected;
        await closed.promise;
        expect(seen.at(-1)?.path).toBe(heldPath);
      },
      (path, response) => {
        if (path === heldPath) {
          response.on("close", () => closed.resolve());
          response.write("{");
          received.resolve();
        } else {
          response.end(JSON.stringify(catalog()));
        }
      },
    );
  },
);

it.each(["/v1/catalog", "/v1/native/openai/v1/decisions"])(
  "expires a held %s response and closes its transport",
  async (heldPath) => {
    const received = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    await fixture(
      async (origin, seen) => {
        const pending = evaluate(origin, { deadlineMonotonicMs: performance.now() + 1000 });
        await Promise.race([received.promise, pending]);
        expect(await pending).toEqual({ status: "unavailable", reason: "transport" });
        expect(seen.at(-1)?.path).toBe(heldPath);
        await closed.promise;
      },
      (path, response) => {
        if (path === heldPath) {
          response.on("close", () => closed.resolve());
          response.write("{");
          received.resolve();
        } else {
          response.end(JSON.stringify(catalog()));
        }
      },
    );
  },
);

it("rechecks admission between catalog and inference and keeps thrown catalog authority terminal", async () => {
  let admitted = true;
  const authority = new Error("retired authority");
  await fixture(
    async (origin, seen) => {
      expect(await evaluate(origin, { isAdmissible: () => admitted })).toEqual({
        status: "unavailable",
        reason: "transport",
      });
      expect(seen).toHaveLength(1);
      await expect(
        evaluate(origin, {
          isAdmissible: () => {
            throw authority;
          },
        }),
      ).rejects.toBe(authority);
      expect(seen).toHaveLength(1);
    },
    (_path, response) => {
      admitted = false;
      response.end(JSON.stringify(catalog()));
    },
  );
});

it("preserves terminal authority revocation after native inference", async () => {
  const authority = new Error("inference authority retired");
  let retired = false;
  await fixture(
    async (origin, seen) => {
      await expect(
        evaluate(origin, {
          isAdmissible: () => {
            if (retired) {
              throw authority;
            }
            return true;
          },
        }),
      ).rejects.toBe(authority);
      expect(seen.map(({ path }) => path)).toEqual([
        "/v1/catalog",
        "/v1/native/openai/v1/decisions",
      ]);
    },
    (path, response) => {
      if (path === "/v1/catalog") {
        response.end(JSON.stringify(catalog()));
      } else {
        retired = true;
        response.end(JSON.stringify(reply));
      }
    },
  );
});
