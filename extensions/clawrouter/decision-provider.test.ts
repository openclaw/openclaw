import type { ServerResponse } from "node:http";
import { attachModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { DecisionBatchV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveBasetenDecisionHttpContext } from "./decision-baseten.runtime.js";
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

it("checks admission again before inference and keeps a thrown authority terminal", async () => {
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

it("checks Baseten admission at the catalog transport handoff", async () => {
  const baseUrl = "https://router.example/v1";
  const model = {
    ...context(baseUrl).model,
    id: "baseten/decision-models/baseten-elephant-9b-latest",
  };
  const handedOff = vi.fn();
  using guard = vi
    .spyOn(providerHttp, "fetchWithTimeoutGuarded")
    .mockImplementation(async (_url, _init, _timeout, _fetch, options) => {
      options?.beforeRequest?.();
      handedOff();
      throw new Error("unexpected handoff");
    });
  const admitted = vi.fn(() => false).mockReturnValueOnce(true);
  await expect(
    evaluate(baseUrl, {
      config: { models: { providers: { clawrouter: { baseUrl, models: [] } } } },
      model,
      isAdmissible: admitted,
    }),
  ).resolves.toEqual({ status: "unavailable", reason: "transport" });
  const terminal = new Error("fixture owner ended admission");
  const ended = vi
    .fn((): boolean => {
      throw terminal;
    })
    .mockReturnValueOnce(true);
  await expect(
    evaluate(baseUrl, {
      config: { models: { providers: { clawrouter: { baseUrl, models: [] } } } },
      model,
      isAdmissible: ended,
    }),
  ).rejects.toBe(terminal);
  expect(guard).toHaveBeenCalledTimes(2);
  expect(handedOff).not.toHaveBeenCalled();
});

it("matches only effective Baseten credentials and excludes automatic protocol headers", () => {
  const baseUrl = "https://router.example/v1";
  const ctx = context(baseUrl);
  const model = {
    id: ctx.model.id,
    name: ctx.model.name,
    provider: "clawrouter",
    api: ctx.model.api,
    baseUrl,
  };
  const config = {
    models: {
      providers: {
        clawrouter: {
          models: [],
          baseUrl,
          headers: { "x-fixture-model": "fixture-provider-value", Accept: "fixture-overridden" },
          request: {
            headers: { "x-fixture-request": "fixture-request-value" },
            auth: {
              mode: "header" as const,
              headerName: "x-fixture-auth",
              prefix: "Schema ",
              value: "fixture-credential",
            },
          },
        },
      },
    },
  };
  const match = resolveBasetenDecisionHttpContext(
    { ...ctx, model, config },
    "fixture-router-key",
  ).reflectsCredential;
  for (const value of [
    "fixture-provider-value",
    "fixture-request-value",
    "fixture-credential",
    "fixture-router-key",
  ]) {
    expect(match(value), value).toBe(true);
  }
  for (const value of ["openclaw", "application/json", "fixture-overridden"]) {
    expect(match(value)).toBe(false);
  }
  const prepared = attachModelProviderRequestTransport(
    {
      ...model,
      headers: {
        "x-fixture-model": "fixture-model-value",
        "x-api-key": "fixture-removed",
        "x-fixture-auth": "Schema fixture-prepared-value",
      },
    },
    {
      allowPrivateNetwork: false,
      auth: {
        mode: "header",
        headerName: "x-fixture-auth",
        prefix: "Schema ",
        value: "fixture-prepared-value",
      },
    },
  );
  const effective = resolveBasetenDecisionHttpContext(
    { ...ctx, config, model: prepared },
    "fixture-router-key",
  ).reflectsCredential;
  expect(effective("fixture-model-value")).toBe(true);
  expect(effective("fixture-prepared-value")).toBe(true);
  for (const value of [
    "fixture-provider-value",
    "fixture-request-value",
    "fixture-credential",
    "fixture-removed",
  ]) {
    expect(effective(value)).toBe(false);
  }
});
