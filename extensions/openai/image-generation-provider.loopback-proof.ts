// Loopback proof harness for Codex OAuth image generation bounded response reads.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { assertCodexImageNoBodyResponseWithinLimit } from "./image-generation-provider.js";

const MAX_CODEX_IMAGE_SSE_BYTES = 64 * 1024 * 1024;
const CODEX_IMAGE_SIZE_LIMIT_ERROR = "OpenAI Codex image generation response exceeded size limit";
const OVERSIZED_CHUNK_BYTES = 1024 * 1024;

export type OpenAICodexImageLoopbackProofCase = {
  mode: string;
  ok: boolean;
  error?: string;
  images?: number;
  cancelObserved?: boolean;
  bodyNullSimulated?: boolean;
  earlyReject?: boolean;
  arrayBufferCalled?: boolean;
  contentLengthBytes?: number;
  payloadBytes?: number;
  ms: number;
};

export type OpenAICodexImageLoopbackProofReport = {
  proof: "openai codex image loopback";
  valid: OpenAICodexImageLoopbackProofCase;
  oversizedStream: OpenAICodexImageLoopbackProofCase;
  oversizedNoBody: OpenAICodexImageLoopbackProofCase;
};

type LoopbackServerMode = "valid" | "oversized-stream" | "oversized-buffered";

type RunningLoopbackServer = {
  server: Server;
  baseUrl: string;
  close: () => Promise<void>;
  wasCanceled: () => boolean;
  bytesSent: () => number;
};

function buildCodexImageSseBody(imageData = "loopback-proof-image"): string {
  const image = Buffer.from(imageData).toString("base64");
  const events = [
    {
      type: "response.output_item.done",
      item: {
        type: "image_generation_call",
        result: image,
        revised_prompt: "loopback proof prompt",
      },
    },
    {
      type: "response.completed",
      response: {
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

async function startLoopbackServer(mode: LoopbackServerMode): Promise<RunningLoopbackServer> {
  let canceled = false;
  let bytesSent = 0;

  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/codex/responses") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    req.on("aborted", () => {
      canceled = true;
    });
    res.on("close", () => {
      if (!res.writableFinished) {
        canceled = true;
      }
    });

    if (mode === "valid") {
      const body = buildCodexImageSseBody();
      bytesSent = Buffer.byteLength(body, "utf8");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(body);
      return;
    }

    if (mode === "oversized-buffered") {
      const body = "x".repeat(MAX_CODEX_IMAGE_SSE_BYTES + 1);
      bytesSent = Buffer.byteLength(body, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Content-Length": String(bytesSent),
      });
      res.end(body);
      return;
    }

    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = Buffer.alloc(OVERSIZED_CHUNK_BYTES, 0x61);

    const writeChunk = () => {
      if (res.writableEnded || res.destroyed) {
        return;
      }
      bytesSent += chunk.length;
      const canContinue = res.write(chunk);
      if (canContinue) {
        setImmediate(writeChunk);
        return;
      }
      res.once("drain", writeChunk);
    };

    writeChunk();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/codex`;

  return {
    server,
    baseUrl,
    wasCanceled: () => canceled,
    bytesSent: () => bytesSent,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function buildLoopbackCfg(baseUrl: string): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl,
          api: "openai-chatgpt-responses",
          request: {
            allowPrivateNetwork: true,
          },
          models: [],
        },
      },
    },
  };
}

async function runValidLoopbackProof(params: {
  generateImage: ImageGenerationProvider["generateImage"];
  authStore: AuthProfileStore;
}): Promise<OpenAICodexImageLoopbackProofCase> {
  const started = performance.now();
  const loopback = await startLoopbackServer("valid");
  try {
    const result = await params.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw a loopback lighthouse",
      cfg: buildLoopbackCfg(loopback.baseUrl),
      authStore: params.authStore,
    });
    return {
      mode: "valid-codex-image-sse-over-loopback",
      ok: true,
      images: result.images.length,
      cancelObserved: loopback.wasCanceled(),
      payloadBytes: loopback.bytesSent(),
      ms: Math.round(performance.now() - started),
    };
  } finally {
    await loopback.close();
  }
}

async function runOversizedStreamLoopbackProof(params: {
  generateImage: ImageGenerationProvider["generateImage"];
  authStore: AuthProfileStore;
}): Promise<OpenAICodexImageLoopbackProofCase> {
  const started = performance.now();
  const loopback = await startLoopbackServer("oversized-stream");
  try {
    await params.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw an oversized loopback lighthouse",
      cfg: buildLoopbackCfg(loopback.baseUrl),
      authStore: params.authStore,
    });
    return {
      mode: "oversized-stream-cancel-over-loopback",
      ok: false,
      error: "expected rejection",
      cancelObserved: loopback.wasCanceled(),
      payloadBytes: loopback.bytesSent(),
      ms: Math.round(performance.now() - started),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: "oversized-stream-cancel-over-loopback",
      ok: message.includes(CODEX_IMAGE_SIZE_LIMIT_ERROR),
      error: message,
      cancelObserved: loopback.wasCanceled(),
      payloadBytes: loopback.bytesSent(),
      ms: Math.round(performance.now() - started),
    };
  } finally {
    await loopback.close();
  }
}

async function runOversizedNoBodyLoopbackProof(): Promise<OpenAICodexImageLoopbackProofCase> {
  const started = performance.now();
  const loopback = await startLoopbackServer("oversized-buffered");
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: `${loopback.baseUrl}/responses`,
      init: {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ stream: true }),
      },
      policy: { allowPrivateNetwork: true },
      auditContext: "openai.image-generation.loopback-proof",
    });
    try {
      Object.defineProperty(response, "body", { value: null });
      const contentLengthBytes = Number(response.headers.get("content-length"));
      let arrayBufferCalled = false;
      const originalArrayBuffer = response.arrayBuffer.bind(response);
      response.arrayBuffer = async () => {
        arrayBufferCalled = true;
        return originalArrayBuffer();
      };

      try {
        assertCodexImageNoBodyResponseWithinLimit(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          mode: "oversized-no-body-over-loopback",
          ok: message.includes(CODEX_IMAGE_SIZE_LIMIT_ERROR),
          error: message,
          bodyNullSimulated: true,
          earlyReject: message.includes(CODEX_IMAGE_SIZE_LIMIT_ERROR),
          arrayBufferCalled,
          contentLengthBytes,
          payloadBytes: loopback.bytesSent(),
          ms: Math.round(performance.now() - started),
        };
      }

      return {
        mode: "oversized-no-body-over-loopback",
        ok: false,
        error: "expected rejection",
        bodyNullSimulated: true,
        earlyReject: false,
        arrayBufferCalled,
        contentLengthBytes,
        payloadBytes: loopback.bytesSent(),
        ms: Math.round(performance.now() - started),
      };
    } finally {
      await release();
    }
  } finally {
    await loopback.close();
  }
}

export async function runOpenAICodexImageLoopbackProof(params: {
  generateImage: ImageGenerationProvider["generateImage"];
  authStore: AuthProfileStore;
}): Promise<OpenAICodexImageLoopbackProofReport> {
  const valid = await runValidLoopbackProof(params);
  const oversizedStream = await runOversizedStreamLoopbackProof(params);
  const oversizedNoBody = await runOversizedNoBodyLoopbackProof();

  return {
    proof: "openai codex image loopback",
    valid,
    oversizedStream,
    oversizedNoBody,
  };
}
