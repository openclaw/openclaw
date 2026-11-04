import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { transcribeAudioFile } from "openclaw/plugin-sdk/media-understanding-runtime";
import { upsertAuthProfileAsync } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it } from "vitest";
import {
  type AudioCatalog,
  withClawRouterAudioFixture as fixture,
} from "./audio-transcription.test-support.js";

type Fixture = Parameters<Parameters<typeof fixture>[0]>[0];
const profiles = [
  { provider: "groq", model: "whisper-large-v3-turbo" },
  { provider: "mistral", model: "voxtral-mini-latest" },
] as const;
const routes = profiles.flatMap((profile) =>
  (["native", "manifest"] as const).map((routeKind) => ({ ...profile, routeKind })),
);
type Route = (typeof routes)[number];
function select(f: Fixture, route: Route) {
  Object.assign(f.catalog, route, {
    endpoint: "transcription",
    requestFormat: `${route.provider}.transcription`,
    responseFormat: `${route.provider}.transcription`,
  });
  const model = `${route.provider}/${route.model}`;
  f.cfg.tools!.media!.models![0]!.model = model;
  return model;
}
function addFallback(f: Fixture) {
  f.cfg.plugins!.allow!.push("openai");
  f.cfg.models!.providers!.openai = {
    baseUrl: f.cfg.models!.providers!.clawrouter!.baseUrl + "/fallback",
    apiKey: "fixture-alternate",
    request: { allowPrivateNetwork: true },
    models: [],
  };
  f.cfg.tools!.media!.models!.push({ provider: "openai", capabilities: ["audio"] });
}

describe("ClawRouter registered Groq and Mistral multipart transcription", () => {
  it.each(routes)("preserves $provider $routeKind wire and selected identity", async (route) => {
    await fixture(
      async (f) => {
        const model = select(f, route);
        const result = await transcribeAudioFile({
          cfg: f.cfg,
          filePath: f.filePath,
          mime: "audio/wav",
          language: "en",
          ...(route.provider === "groq" ? { prompt: "synthetic proper noun" } : {}),
        });
        expect(result).toMatchObject({
          text: "complete transcript",
          provider: "clawrouter",
          model,
        });
        expect(f.catalogRequests).toEqual(["Bearer fixture-router"]);
        expect(f.requests).toHaveLength(1);
        expect(f.rawRequests).toHaveLength(0);
        const request = f.requests[0]!;
        expect(request).toMatchObject({
          authorization: "Bearer fixture-router",
          url:
            route.routeKind === "native"
              ? `/v1/native/${route.provider}/v1/audio/transcriptions`
              : `/v1/proxy/${route.provider}/transcription`,
        });
        expect(request.form.get("model")).toBe(route.routeKind === "native" ? route.model : model);
        expect([...request.form.keys()]).toEqual(
          route.provider === "groq"
            ? ["model", "language", "prompt", "file"]
            : ["model", "language", "file"],
        );
        expect(request.form.get("language")).toBe("en");
        expect(request.form.get("prompt")).toBe(
          route.provider === "groq" ? "synthetic proper noun" : null,
        );
        const file = request.form.get("file") as File;
        expect(file.name).toBe("meeting (1).wav");
        expect(request.body.toString("latin1")).toMatch(/content-type: audio\/wav\r\n/i);
        expect(Buffer.from(await file.arrayBuffer())).toEqual(f.audio);
      },
      (res) => {
        res.setHeader("content-type", "application/json");
        res.write('{"text":"complete');
        res.end(
          ' transcript","model":"observed-serving-model","usage":{"prompt_audio_seconds":2}}',
        );
      },
    );
  });

  it.each<[string, Partial<AudioCatalog>]>([
    ["stale observation", { observedAt: "2000-01-01T00:00:00Z" }],
    ["foreign scope", { authType: "access" }],
    ["revoked grant", { eligible: false }],
    ["foreign origin", { route: "https://foreign.example/transcription" }],
    ["wrong provider route", { route: "/v1/native/openai/v1/audio/transcriptions" }],
    ["plural endpoint", { endpoint: "transcriptions" }],
    ["compat format", { requestFormat: "openai.audio_transcriptions" }],
    ["wrong response format", { responseFormat: "openai.audio_transcriptions" }],
    ["wrong model", { model: "unqualified-model" }],
    ["wrong upstream", { upstream: "unqualified-model" }],
  ])("denies %s before uploading", async (_name, change) => {
    await fixture(async (f) => {
      select(f, routes[3]!);
      Object.assign(f.catalog, change);
      await expect(transcribeAudioFile({ cfg: f.cfg, filePath: f.filePath })).rejects.toThrow(
        /catalog/,
      );
      expect(f.requests).toHaveLength(0);
      expect(f.rawRequests).toHaveLength(0);
    });
  });

  it.each(routes)("rejects $provider $routeKind query options before discovery", async (route) => {
    await fixture(async (f) => {
      select(f, route);
      f.cfg.tools!.media!.models![0]!.providerOptions = { clawrouter: { temperature: 1 } };
      await expect(transcribeAudioFile({ cfg: f.cfg, filePath: f.filePath })).rejects.toThrow(
        /providerOptions/,
      );
      expect(f.catalogRequests).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
    });
  });

  it.each(["native", "manifest"] as const)(
    "rejects Mistral prompt before %s upload",
    async (routeKind) => {
      await fixture(async (f) => {
        select(f, { ...profiles[1], routeKind });
        await expect(
          transcribeAudioFile({ cfg: f.cfg, filePath: f.filePath, prompt: "unsupported" }),
        ).rejects.toThrow(/does not support prompt/);
        expect(f.catalogRequests).toHaveLength(0);
        expect(f.requests).toHaveLength(0);
      });
    },
  );

  it.each([
    { name: "oversized prompt", input: { prompt: "x".repeat(4097) }, error: /4 KiB/ },
    { name: "unsupported language", input: { language: "eng" }, error: /two-letter/ },
    { name: "AAC relabel", input: { mime: "audio/aac" }, error: /MIME|AAC/ },
  ])("rejects Groq $name before discovery", async ({ input, error }) => {
    await fixture(async (f) => {
      select(f, routes[0]!);
      await expect(
        transcribeAudioFile({ cfg: f.cfg, filePath: f.filePath, ...input }),
      ).rejects.toThrow(error);
      expect(f.catalogRequests).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
    });
  });

  it("retains a working alternate for a proven pre-upload denial", async () => {
    await fixture(async (f) => {
      select(f, routes[0]!);
      addFallback(f);
      f.catalog.eligible = false;
      const result = await transcribeAudioFile({ cfg: f.cfg, filePath: f.filePath });
      expect(result).toMatchObject({ provider: "openai", text: "synthetic transcript" });
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]?.url).toBe("/fallback/audio/transcriptions");
    });
  });

  it.each([
    "pricing",
    "redirect",
    "malformed",
    "partial",
    "embedded error",
    "empty text",
    "oversized",
    "invalid UTF-8",
    "lost response",
    "partial status",
  ])("never contacts an alternate after %s", async (failure) => {
    await fixture(
      async (f) => {
        select(f, routes[3]!);
        addFallback(f);
        await expect(transcribeAudioFile({ cfg: f.cfg, filePath: f.filePath })).rejects.toThrow();
        expect(f.requests).toHaveLength(1);
        expect(f.requests[0]?.url).toBe("/v1/proxy/mistral/transcription");
      },
      (res) => {
        res.setHeader("content-type", "application/json");
        if (failure === "pricing") {
          res.statusCode = 400;
          res.end('{"error":{"code":"pricing_required"}}');
        } else if (failure === "redirect") {
          res.statusCode = 307;
          res.setHeader("location", "/replayed");
          res.end();
        } else if (failure === "malformed") {
          res.end('{"text":');
        } else if (failure === "oversized") {
          res.end(JSON.stringify({ text: "x".repeat(1024 * 1024) }));
        } else if (failure === "invalid UTF-8") {
          res.end(Buffer.from([0xff]));
        } else if (failure === "lost response") {
          res.destroy();
        } else {
          if (failure === "partial status") {
            res.statusCode = 206;
          }
          res.end(
            JSON.stringify({
              text: failure === "empty text" ? " " : "unusable",
              ...(failure === "partial" ? { finish_reason: "length" } : {}),
              ...(failure === "embedded error" ? { error: "failed" } : {}),
            }),
          );
        }
      },
    );
  });

  it.each(["catalog", "body"])(
    "propagates caller abort through %s and releases the socket",
    async (phase) => {
      const started = createDeferred();
      const closed = createDeferred();
      const stall: NonNullable<Parameters<typeof fixture>[1]> = (res) => {
        res.setHeader("content-type", "application/json");
        res.write('{"text":"');
        res.once("close", () => closed.resolve());
        started.resolve();
      };
      await fixture(
        async (f) => {
          select(f, routes[0]!);
          addFallback(f);
          const caller = new AbortController();
          const pending = transcribeAudioFile(
            { cfg: f.cfg, filePath: f.filePath },
            {
              signal: caller.signal,
              assertCurrent: () => {},
            },
          );
          const rejected = expect(pending).rejects.toThrow(/abort|cancel/i);
          await started.promise;
          caller.abort();
          await rejected;
          await closed.promise;
          expect(f.requests).toHaveLength(phase === "catalog" ? 0 : 1);
          expect(f.requests.some((request) => request.url.includes("fallback"))).toBe(false);
        },
        phase === "body" ? stall : undefined,
        phase === "catalog" ? stall : undefined,
      );
    },
  );

  it("enforces the original operation deadline during a partial manifest response", async () => {
    const closed = createDeferred();
    await fixture(
      async (f) => {
        select(f, routes[3]!);
        addFallback(f);
        f.cfg.tools!.media!.audio!.timeoutSeconds = 0.25;
        await expect(transcribeAudioFile({ cfg: f.cfg, filePath: f.filePath })).rejects.toThrow(
          /timeout|timed out|deadline/i,
        );
        await closed.promise;
        expect(f.requests).toHaveLength(1);
        expect(f.requests[0]?.url).toBe("/v1/proxy/mistral/transcription");
      },
      (res) => {
        res.setHeader("content-type", "application/json");
        res.write('{"text":"partial');
        res.once("close", () => closed.resolve());
      },
    );
  });

  it("does not use native vendor keys when the proxy credential is missing", async () => {
    await fixture(async (f) => {
      select(f, routes[0]!);
      delete f.cfg.models!.providers!.clawrouter!.apiKey;
      await expect(transcribeAudioFile({ cfg: f.cfg, filePath: f.filePath })).rejects.toThrow();
      expect(f.catalogRequests).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
    });
  });

  it("uses the locked proxy profile and refuses a native vendor profile", async () => {
    await fixture(async (f) => {
      select(f, routes[3]!);
      const agentDir = f.home + "/.openclaw/agents/main/agent";
      await upsertAuthProfileAsync({
        agentDir,
        profileId: "clawrouter:transcription",
        credential: { type: "api_key", provider: "clawrouter", key: "fixture-stored-router" },
      });
      await upsertAuthProfileAsync({
        agentDir,
        profileId: "mistral:transcription",
        credential: { type: "api_key", provider: "mistral", key: "fixture-vendor-never-router" },
      });
      f.cfg.tools!.media!.models![0]!.profile = "clawrouter:transcription";
      await transcribeAudioFile({ cfg: f.cfg, filePath: f.filePath, agentDir });
      expect(f.catalogRequests).toEqual(["Bearer fixture-stored-router"]);
      expect(f.requests.map((request) => request.authorization)).toEqual([
        "Bearer fixture-stored-router",
      ]);
      f.cfg.tools!.media!.models![0]!.profile = "mistral:transcription";
      await expect(
        transcribeAudioFile({ cfg: f.cfg, filePath: f.filePath, agentDir }),
      ).rejects.toThrow(/unavailable for ClawRouter/);
      expect(f.catalogRequests).toHaveLength(1);
      expect(f.requests).toHaveLength(1);
    });
  });

  it("stops a caller already aborted before discovery or upload", async () => {
    await fixture(async (f) => {
      select(f, routes[1]!);
      const caller = new AbortController();
      caller.abort();
      await expect(
        transcribeAudioFile(
          { cfg: f.cfg, filePath: f.filePath },
          {
            signal: caller.signal,
            assertCurrent: () => {},
          },
        ),
      ).rejects.toThrow(/abort|cancel/i);
      expect(f.catalogRequests).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
    });
  });
});
