import { createServer } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createCapturedPluginRegistration,
  createEmptyPluginRegistry,
  createPluginMetadataSnapshotFixture,
  createTestPluginRuntimeOwner,
  withPluginRuntimeGenerationScope,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  awaitGateBeforeSettlement,
  reserveTestPortListener,
} from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, onTestFinished, vi } from "vitest";
import { WebSocketServer } from "ws";
import elevenlabs from "./index.js";

type Stream = NonNullable<
  OpenClawPluginApi["runtime"]["mediaUnderstanding"]["transcribeAudioStream"]
>;
const format = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 } as const;
const apiKey = "synthetic-elevenlabs-integration-key";

async function withRuntime(run: (transcribe: Stream, revoke: () => void) => Promise<void>) {
  const registered = createCapturedPluginRegistration({
    id: "elevenlabs",
    name: "ElevenLabs Speech",
  });
  elevenlabs.register(registered.api);
  const pluginRegistry = createEmptyPluginRegistry();
  pluginRegistry.mediaUnderstandingProviders.push(
    ...registered.mediaUnderstandingProviders.map((provider) => ({
      pluginId: "elevenlabs",
      source: "test",
      provider,
    })),
  );
  pluginRegistry.realtimeTranscriptionProviders.push(
    ...registered.realtimeTranscriptionProviders.map((provider) => ({
      pluginId: "elevenlabs",
      source: "test",
      provider,
    })),
  );
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "elevenlabs",
        contracts: {
          mediaUnderstandingProviders: ["elevenlabs"],
          realtimeTranscriptionProviders: ["elevenlabs"],
        },
      },
    ],
  });
  const consumer = await createTestPluginRuntimeOwner("finite-stream-consumer");
  onTestFinished(() => consumer.dispose());
  const runtime = consumer.runtime;
  await withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, () =>
    run((params) => {
      if (!runtime.mediaUnderstanding.transcribeAudioStream) {
        throw new Error("Public runtime did not expose finite transcription");
      }
      return runtime.mediaUnderstanding.transcribeAudioStream(params);
    }, consumer.revoke),
  );
}

function config(baseUrl: string, model = "scribe_v2_realtime"): OpenClawConfig {
  return {
    plugins: { allow: ["elevenlabs"], entries: { elevenlabs: { enabled: true } } },
    models: { providers: { elevenlabs: { baseUrl, apiKey, models: [] } } },
    tools: { media: { models: [{ provider: "elevenlabs", model, capabilities: ["audio"] }] } },
  };
}

async function protocolFixture(options: { holdCommit?: boolean } = {}) {
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
  vi.stubEnv("ELEVENLABS_API_KEY", "unused-ambient-key");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const frames: Buffer[] = [];
  const commits: number[] = [];
  const requests: Array<{ url: URL; key: string | string[] | undefined }> = [];
  const firstAudio = createDeferred();
  const firstCommit = createDeferred();
  const releaseCommit = createDeferred();
  onTestFinished(() => releaseCommit.resolve());
  const closed = createDeferred();
  let batchRequests = 0;
  const reserved = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((_request, response) => {
        batchRequests += 1;
        response.writeHead(500).end("Unexpected batch transcription");
      }),
  });
  const wss = new WebSocketServer({ server: reserved.listener });
  onTestFinished(async () => {
    for (const socket of wss.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await reserved.releaseListener();
    await reserved.claim.release();
  });
  wss.on("connection", (socket, request) => {
    requests.push({
      url: new URL(request.url ?? "/", "http://fixture.invalid"),
      key: request.headers["xi-api-key"],
    });
    socket.once("close", () => closed.resolve());
    socket.send(JSON.stringify({ message_type: "session_started" }));
    socket.on("message", (data) => {
      const buffer = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      const message = JSON.parse(buffer.toString()) as { audio_base_64: string; commit: boolean };
      if (message.commit) {
        commits.push(Buffer.concat(frames).length);
        const response = JSON.stringify({
          message_type: "committed_transcript",
          text: commits.length === 1 ? "First segment." : "Final starlight.",
        });
        firstCommit.resolve();
        if (options.holdCommit) {
          void releaseCommit.promise.then(() => socket.send(response));
        } else {
          socket.send(response);
        }
      } else {
        frames.push(Buffer.from(message.audio_base_64, "base64"));
        firstAudio.resolve();
      }
    });
  });
  return {
    cfg: config(`http://127.0.0.1:${reserved.claim.port}`),
    frames,
    commits,
    requests,
    firstAudio: firstAudio.promise,
    firstCommit: firstCommit.promise,
    releaseCommit: () => releaseCommit.resolve(),
    closed: closed.promise,
    batchRequests: () => batchRequests,
  };
}

it("streams through the public runtime and registered ElevenLabs provider before input ends", async () => {
  const fixture = await protocolFixture();
  await withRuntime(async (transcribe) => {
    const release = createDeferred();
    onTestFinished(() => release.resolve());
    let inputEnded = false;
    const chunks = Array.from({ length: 9 }, (_, index) => Buffer.alloc(32000, index + 1));
    async function* audio() {
      yield chunks[0]!;
      await release.promise;
      yield* chunks.slice(1);
      inputEnded = true;
    }
    const pending = transcribe({
      cfg: fixture.cfg,
      agentId: "voice",
      format,
      audio: audio(),
      signal: new AbortController().signal,
    });
    await awaitGateBeforeSettlement(
      fixture.firstAudio,
      pending,
      "Transcription settled before uploading audio",
    );
    expect(inputEnded).toBe(false);
    expect(fixture.commits).toEqual([]);
    release.resolve();
    const result = await pending;
    expect(result).toEqual({
      supported: true,
      text: "First segment. Final starlight.",
      no_speech: false,
      mode: "realtime",
      provider: "elevenlabs",
      model: "scribe_v2_realtime",
    });
    await fixture.closed;
    expect(Buffer.concat(fixture.frames).equals(Buffer.concat(chunks))).toBe(true);
    expect(fixture.commits).toEqual([256000, 288000]);
    console.info(
      "FINITE_STT_BOUNDARY_TRACE",
      JSON.stringify({
        scenario: "complete",
        connections: fixture.requests.length,
        audioBytes: Buffer.concat(fixture.frames).length,
        commits: fixture.commits,
        result,
      }),
    );
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.key).toBe(apiKey);
    expect(fixture.requests[0]?.url.pathname).toBe("/v1/speech-to-text/realtime");
    expect(fixture.requests[0]?.url.searchParams.get("commit_strategy")).toBe("manual");
    expect(fixture.requests[0]?.url.searchParams.get("audio_format")).toBe("pcm_16000");
    expect(fixture.batchRequests()).toBe(0);
  });
});

it("cancels the real provider socket without sending late input or replaying through batch", async () => {
  const fixture = await protocolFixture();
  await withRuntime(async (transcribe) => {
    const controller = new AbortController();
    const release = createDeferred();
    onTestFinished(() => release.resolve());
    const sourceClosed = createDeferred();
    async function* audio() {
      try {
        yield Buffer.alloc(320);
        await release.promise;
        yield Buffer.alloc(320, 1);
      } finally {
        sourceClosed.resolve();
      }
    }
    const pending = transcribe({
      cfg: fixture.cfg,
      agentId: "voice",
      format,
      audio: audio(),
      signal: controller.signal,
    });
    await awaitGateBeforeSettlement(
      fixture.firstAudio,
      pending,
      "Transcription settled before uploading audio",
    );
    controller.abort(new Error("Canceled synthetic utterance"));
    await expect(pending).rejects.toThrow(/abort|Canceled/i);
    await fixture.closed;
    release.resolve();
    await sourceClosed.promise;
    expect(fixture.frames.map((frame) => frame.length)).toEqual([320]);
    expect(fixture.commits).toEqual([]);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.batchRequests()).toBe(0);
    console.info(
      "FINITE_STT_BOUNDARY_TRACE",
      JSON.stringify({
        scenario: "caller-cancellation",
        connections: fixture.requests.length,
        audioBytes: Buffer.concat(fixture.frames).length,
        commits: fixture.commits,
        batchRequests: fixture.batchRequests(),
      }),
    );
  });
});

it.each(["before-connect", "before-next-upload", "before-commit"] as const)(
  "fences the real registered consumer after revocation: %s",
  async (boundary) => {
    const fixture = await protocolFixture();
    await withRuntime(async (transcribe, revoke) => {
      const paused = createDeferred();
      const release = createDeferred();
      const sourceClosed = createDeferred();
      onTestFinished(() => release.resolve());
      async function* audio() {
        try {
          if (boundary !== "before-connect") {
            yield Buffer.alloc(320);
          }
          paused.resolve();
          await release.promise;
          if (boundary !== "before-commit") {
            yield Buffer.alloc(320, 1);
          }
        } finally {
          sourceClosed.resolve();
        }
      }
      const pending = transcribe({
        cfg: fixture.cfg,
        agentId: "voice",
        format,
        audio: audio(),
        signal: new AbortController().signal,
      });
      await awaitGateBeforeSettlement(
        paused.promise,
        pending,
        "Input did not reach revocation gate",
      );
      if (boundary !== "before-connect") {
        await awaitGateBeforeSettlement(
          fixture.firstAudio,
          pending,
          "Audio did not reach provider",
        );
      }
      revoke();
      release.resolve();
      await expect(pending).rejects.toThrow("runtime is no longer active");
      await sourceClosed.promise;
      if (boundary !== "before-connect") {
        await fixture.closed;
      }
      expect(fixture.frames.map((frame) => frame.length)).toEqual(
        boundary === "before-connect" ? [] : [320],
      );
      expect(fixture.requests).toHaveLength(boundary === "before-connect" ? 0 : 1);
      expect(fixture.commits).toEqual([]);
      expect(fixture.batchRequests()).toBe(0);
      console.info(
        "FINITE_STT_BOUNDARY_TRACE",
        JSON.stringify({
          scenario: boundary,
          outcome: "revoked",
          connections: fixture.requests.length,
          audioBytes: Buffer.concat(fixture.frames).length,
          commits: fixture.commits,
        }),
      );
    });
  },
);

it("fences an already accepted write resumed by a late segment acknowledgment", async () => {
  const fixture = await protocolFixture({ holdCommit: true });
  await withRuntime(async (transcribe, revoke) => {
    const pending = transcribe({
      cfg: fixture.cfg,
      agentId: "voice",
      format,
      audio: (async function* () {
        for (let index = 0; index < 7; index += 1) {
          yield Buffer.alloc(32000);
        }
        // The first 32000 bytes fill the segment; the last 768 resume after its acknowledgment.
        yield Buffer.alloc(32768);
      })(),
      signal: new AbortController().signal,
    });
    await awaitGateBeforeSettlement(
      fixture.firstCommit,
      pending,
      "No segment reached the provider",
    );
    revoke();
    fixture.releaseCommit();
    await expect(pending).rejects.toThrow("runtime is no longer active");
    await fixture.closed;
    expect(Buffer.concat(fixture.frames)).toHaveLength(256000);
    expect(fixture.commits).toEqual([256000]);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.batchRequests()).toBe(0);
    console.info(
      "FINITE_STT_BOUNDARY_TRACE",
      JSON.stringify({
        scenario: "queued-write-after-ack",
        outcome: "revoked",
        audioBytes: 256000,
        rejectedBytes: 768,
        commits: fixture.commits,
      }),
    );
  });
});

it("leaves unsupported input untouched and enforces policy at the public runtime boundary", async () => {
  let reads = 0;
  const audio = {
    [Symbol.asyncIterator]() {
      reads += 1;
      return (async function* () {
        yield Buffer.alloc(320);
      })();
    },
  };
  await withRuntime(async (transcribe) => {
    const cfg = config("http://127.0.0.1:1", "scribe_v2");
    const params = { cfg, agentId: "voice", format, audio, signal: new AbortController().signal };
    await expect(transcribe(params)).resolves.toEqual({
      supported: false,
      reason: "selected_model_requires_batch",
    });
    await expect(
      transcribe({
        ...params,
        cfg: {
          ...cfg,
          tools: { media: { ...cfg.tools?.media, audio: { scope: { default: "deny" } } } },
        },
      }),
    ).rejects.toThrow("disabled by policy");
    expect(reads).toBe(0);
  });
});
