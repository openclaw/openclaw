import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { transcribeAudioFile } from "openclaw/plugin-sdk/media-understanding-runtime";
import { upsertAuthProfileAsync } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it } from "vitest";
import {
  respondPricingRequired,
  withClawRouterAudioFixture as fixture,
} from "./audio-transcription.test-support.js";

type Fixture = Parameters<Parameters<typeof fixture>[0]>[0];
async function rejectsUpload(message: RegExp, respond: Parameters<typeof fixture>[1]) {
  await fixture(async ({ cfg, filePath, requests }) => {
    await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(message);
    expect(requests).toHaveLength(1);
  }, respond);
}

function enableFallback(cfg: Fixture["cfg"]) {
  delete cfg.tools!.media!.models;
  cfg.plugins!.allow!.push("openai");
  cfg.models!.providers!.openai = {
    baseUrl: cfg.models!.providers!.clawrouter!.baseUrl + "/fallback",
    apiKey: "fixture-fallback",
    request: { allowPrivateNetwork: true },
    models: [],
  };
}

function holdTranscript(
  res: Parameters<NonNullable<Parameters<typeof fixture>[1]>>[0],
  close: () => void,
) {
  res.setHeader("content-type", "application/json");
  res.write('{"text":"');
  res.once("close", close);
}

describe("ClawRouter registered file transcription", () => {
  it("uses the native default, scoped router auth and byte-exact multipart through the media runner", async () => {
    await fixture(async ({ cfg, filePath, requests, audio }) => {
      cfg.tools!.media!.models![0]!.maxChars = 9;
      const result = await transcribeAudioFile({
        cfg,
        filePath,
        mime: "audio/wav",
        language: "en",
        prompt: "synthetic hint",
      });
      expect(result).toMatchObject({
        text: "synthetic",
        provider: "clawrouter",
        model: "gpt-4o-transcribe",
        decision: { outcome: "success" },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: "/v1/native/openai/v1/audio/transcriptions",
        authorization: "Bearer fixture-router",
      });
      const form = requests[0]!.form;
      expect([...form.keys()]).toEqual(["model", "language", "prompt", "file"]);
      expect(form.get("model")).toBe("gpt-4o-transcribe");
      expect(form.get("language")).toBe("en");
      expect(form.get("prompt")).toBe("synthetic hint");
      const file = form.get("file") as File;
      expect(file.name).toBe("meeting (1).wav");
      expect(file.type).toBe("audio/x-wav");
      expect(Buffer.from(await file.arrayBuffer())).toEqual(audio);
    });
  });
  it.each([
    ["missing router key", { apiKey: undefined }, {}, /API key|credential/i],
    ["unsupported model", {}, { model: "whisper-1" }, /only gpt-4o-transcribe/],
    [
      "unsupported options",
      {},
      { providerOptions: { clawrouter: { response_format: "verbose_json" } } },
      /providerOptions/,
    ],
    ["private network", { request: { allowPrivateNetwork: false } }, {}, /Blocked hostname/],
    [
      "credential override",
      {},
      { headers: { authorization: "Bearer fixture-foreign" } },
      /header overrides/,
    ],
  ] as const)("rejects %s before uploading", async (_name, provider, model, message) => {
    await fixture(async ({ cfg, filePath, requests }) => {
      Object.assign(cfg.models!.providers!.clawrouter!, provider);
      Object.assign(cfg.tools!.media!.models![0]!, model);
      await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(message);
      expect(requests).toHaveLength(0);
    });
  });
  it.each(["not-json", JSON.stringify({ text: 42 })])(
    "rejects malformed provider payload %s without replay",
    async (body) => {
      await rejectsUpload(/JSON|text/, (res) => res.end(body));
    },
  );
  it("does not leak a rejected credential in a provider error", async () => {
    await fixture(
      async ({ cfg, filePath, requests }) => {
        const error = await transcribeAudioFile({ cfg, filePath }).catch(String);
        expect(String(error)).toMatch(/401.*invalid_api_key/);
        expect(String(error)).not.toContain("fixture-router");
        expect(requests).toHaveLength(1);
      },
      (res) => {
        res.statusCode = 401;
        res.end(
          JSON.stringify({
            error: { code: "invalid_api_key", message: "Bearer fixture-router rejected" },
          }),
        );
      },
    );
  });
  it("locks stored ClawRouter profiles without borrowing missing or foreign credentials", async () => {
    await fixture(async ({ cfg, filePath, requests, home }) => {
      const agentDir = home + "/.openclaw/agents/main/agent";
      await upsertAuthProfileAsync({
        agentDir,
        profileId: "clawrouter:stt",
        credential: { type: "api_key", provider: "clawrouter", key: "fixture-stored-router" },
      });
      await upsertAuthProfileAsync({
        agentDir,
        profileId: "openai:stt",
        credential: { type: "api_key", provider: "openai", key: "fixture-stored-openai" },
      });
      cfg.tools!.media!.models![0]!.profile = "clawrouter:stt";
      await transcribeAudioFile({ cfg, filePath, agentDir });
      expect(requests.map((request) => request.authorization)).toEqual([
        "Bearer fixture-stored-router",
      ]);
      for (const profile of ["clawrouter:missing", "openai:stt"]) {
        cfg.tools!.media!.models![0]!.profile = profile;
        await expect(transcribeAudioFile({ cfg, filePath, agentDir })).rejects.toThrow(
          /unavailable for ClawRouter/,
        );
      }
      expect(requests).toHaveLength(1);
    });
  });
  it("cancels an in-flight response body and releases its socket without upload replay", async () => {
    const started = createDeferred();
    const closed = createDeferred();
    await fixture(
      async ({ cfg, filePath, requests }) => {
        const caller = new AbortController();
        const pending = transcribeAudioFile(
          { cfg, filePath },
          { signal: caller.signal, assertCurrent: () => {} },
        );
        const rejection = expect(pending).rejects.toThrow(/abort|cancel/i);
        await started.promise;
        caller.abort();
        await rejection;
        await closed.promise;
        expect(requests).toHaveLength(1);
      },
      (res) => {
        holdTranscript(res, () => closed.resolve());
        started.resolve();
      },
    );
  });
  it("rejects an upload beyond the configured byte bound before any HTTP request", async () => {
    await fixture(async ({ cfg, filePath, requests }) => {
      cfg.tools!.media!.models![0]!.maxBytes = 2047;
      const result = await transcribeAudioFile({ cfg, filePath });
      expect(result.text).toBeUndefined();
      expect(result.decision?.attachments[0]?.attempts[0]?.reason).toContain("maxBytes");
      expect(requests).toHaveLength(0);
    });
  });
  it("honors an explicit proxy instead of uploading directly when the proxy refuses a tunnel", async () => {
    await fixture(async ({ cfg, filePath, requests }) => {
      const connects: string[] = [];
      const sockets = new Set<Socket>();
      const proxy = createTcpServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.once("data", (data) => {
          connects.push(data.toString().split("\r\n")[0]!);
          socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        });
      });
      await new Promise<void>((resolve) => {
        proxy.listen(0, "127.0.0.1", resolve);
      });
      const address = proxy.address() as AddressInfo;
      cfg.models!.providers!.clawrouter!.request = {
        allowPrivateNetwork: true,
        proxy: { mode: "explicit-proxy", url: `http://127.0.0.1:${address.port}` },
      };
      try {
        await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(/fetch|proxy|tunnel/i);
        expect(connects.length).toBeGreaterThan(0);
        expect(connects[0]).toMatch(/^CONNECT 127\.0\.0\.1:/);
        expect(requests).toHaveLength(0);
      } finally {
        await new Promise<void>((resolve, reject) => {
          proxy.close((error) => (error ? reject(error) : resolve()));
          for (const socket of sockets) {
            socket.destroy();
          }
        });
      }
    });
  });
  it("does not replay a multipart upload through a redirect", async () => {
    await rejectsUpload(/fetch|redirect/i, (res) => {
      res.statusCode = 307;
      res.setHeader("location", "/redirected");
      res.end();
    });
  });
  it("honors the configured deadline through response EOF and releases the socket", async () => {
    const closed = createDeferred();
    await fixture(
      async ({ cfg, filePath, requests }) => {
        cfg.tools!.media!.models![0]!.timeoutSeconds = 0.1;
        await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(/abort|timed out/i);
        await closed.promise;
        expect(requests).toHaveLength(1);
      },
      (res) => holdTranscript(res, () => closed.resolve()),
    );
  });
});

// A distinct registered-runtime boundary: automatic preparation may continue,
// but uploading a recording commits that automatic attempt to one provider.
describe("ClawRouter automatic transcription", () => {
  it.each([
    { name: "missing key", fileName: undefined, reason: undefined },
    { name: "AAC filename", fileName: "voice.aac", reason: "safe upload filename" },
    { name: "unsafe filename", fileName: "voice[1].wav", reason: "safe upload filename" },
    { name: "private-network policy", fileName: undefined, reason: "Blocked hostname" },
  ])(
    "continues before upload after $name without disclosing to ClawRouter",
    async ({ name, fileName, reason }) => {
      await fixture(async ({ cfg, filePath, requests, home }) => {
        enableFallback(cfg);
        let uploadPath = filePath;
        if (name === "missing key") {
          delete cfg.models!.providers!.clawrouter!.apiKey;
        } else if (fileName) {
          const nextPath = home + "/" + fileName;
          await fs.rename(filePath, nextPath);
          uploadPath = nextPath;
        }
        if (name === "private-network policy") {
          cfg.models!.providers!.clawrouter!.request = { allowPrivateNetwork: false };
        }
        const result = await transcribeAudioFile({
          cfg,
          filePath: uploadPath,
          mime: "audio/wav",
          activeModel: { provider: "clawrouter", model: "chat-model-not-transcription" },
        });
        expect(result).toMatchObject({ text: "synthetic transcript", provider: "openai" });
        expect(requests.map(({ url, authorization }) => ({ url, authorization }))).toEqual([
          { url: "/fallback/audio/transcriptions", authorization: "Bearer fixture-fallback" },
        ]);
        const attempts = result.decision?.attachments[0]?.attempts;
        expect(attempts).toEqual([
          ...(reason
            ? [
                expect.objectContaining({
                  provider: "clawrouter",
                  outcome: "failed",
                  reason: expect.stringContaining(reason),
                }),
              ]
            : []),
          expect.objectContaining({ provider: "openai", outcome: "success" }),
        ]);
      });
    },
  );

  it("stops automatic selection after a pricing_required HTTP upload without contacting another provider", async () => {
    await fixture(async ({ cfg, filePath, requests }) => {
      enableFallback(cfg);
      await expect(
        transcribeAudioFile({
          cfg,
          filePath,
          activeModel: { provider: "clawrouter", model: "chat-model" },
        }),
      ).rejects.toThrow(/pricing_required/);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: "/v1/native/openai/v1/audio/transcriptions",
        authorization: "Bearer fixture-router",
      });
    }, respondPricingRequired);
  });
});
