import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildChatCompletionResponse,
  buildChatCompletionStreamChunks,
  openAiMessagesToPrompt,
  requestDeclaresTools,
  ToolsNotSupportedError,
} from "./message-translator.js";
import type { SdkClient } from "./sdk-client.js";
import type { OpenAiChatRequest } from "./shared-types.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Thrown by request-parsing helpers so the top-level handler can return 400. */
class ClientRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientRequestError";
  }
}

export type ShimServerOptions = {
  /** SDK client used to fulfill chat completions. Injected so tests can mock it. */
  client: SdkClient;
  /** Loopback port to bind (0 = ephemeral). */
  port?: number;
  /**
   * When true (default), the shim returns HTTP 400 for requests that declare
   * tools. When false, tools are silently dropped.
   */
  rejectToolRequests?: boolean;
};

export type ShimServerHandle = {
  url: string;
  port: number;
  close(): Promise<void>;
};

/**
 * Starts the OpenAI-compatible HTTP shim on 127.0.0.1. Routes:
 *   GET  /v1/models                 -> proxies to SDK client.listModels
 *   POST /v1/chat/completions       -> proxies to SDK client.runPrompt
 * Anything else 404s so misconfigured callers fail fast.
 *
 * The server binds to the loopback interface only; it is never exposed on a
 * non-loopback interface by design.
 */
export async function startShimServer(options: ShimServerOptions): Promise<ShimServerHandle> {
  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res, options);
    } catch (error) {
      const msg = toMessage(error);
      if (error instanceof ClientRequestError) {
        writeJson(res, 400, { error: { message: msg, type: "invalid_request" } });
      } else {
        writeJson(res, 500, { error: { message: msg, type: "internal_error" } });
      }
    }
  });

  const requestedPort = options.port ?? 0;
  try {
    await listenOn(server, requestedPort);
  } catch (err) {
    if (isAddrInUse(err) && requestedPort !== 0) {
      // Stale shim from a previous process — fall back to an ephemeral port.
      await listenOn(server, 0);
    } else {
      throw err;
    }
  }

  // Allow the process to exit even while the shim is listening. The shim
  // stays alive as long as the host (agent/gateway) keeps its own event loop
  // running. For short-lived commands like `models list`, Node can exit
  // immediately after the catalog completes.
  server.unref();

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === "string") {
    throw new Error("copilot-sdk shim failed to bind a loopback port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ShimServerOptions,
): Promise<void> {
  const url = req.url ?? "";
  const method = (req.method ?? "GET").toUpperCase();

  if (method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
    const models = await options.client.listModels();
    writeJson(res, 200, {
      object: "list",
      data: models.map((model) => ({
        id: model.id,
        object: "model",
        created: 0,
        owned_by: "github-copilot",
      })),
    });
    return;
  }

  if (method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
    const body = await readJsonBody<OpenAiChatRequest>(req);
    if (!body || typeof body !== "object") {
      writeJson(res, 400, {
        error: { message: "Request body must be a JSON object", type: "invalid_request" },
      });
      return;
    }
    if (!body.model || !Array.isArray(body.messages)) {
      writeJson(res, 400, {
        error: {
          message: "Missing required fields `model` and `messages`",
          type: "invalid_request",
        },
      });
      return;
    }

    const reject = options.rejectToolRequests ?? false;
    if (reject && requestDeclaresTools(body)) {
      const err = new ToolsNotSupportedError();
      writeJson(res, 400, { error: { message: err.message, type: err.code } });
      return;
    }
    if (!reject && requestDeclaresTools(body)) {
      console.warn("copilot-sdk shim: stripping tools from request (not supported by Copilot CLI)");
    }

    const prompt = openAiMessagesToPrompt(body.messages);
    if (!prompt) {
      writeJson(res, 400, {
        error: { message: "No textual content found in `messages`", type: "invalid_request" },
      });
      return;
    }

    const { content } = await options.client.runPrompt({
      model: body.model,
      prompt,
      timeoutMs: 120_000,
    });
    if (body.stream) {
      writeSseHeaders(res);
      for (const chunk of buildChatCompletionStreamChunks({ model: body.model, content })) {
        res.write(chunk);
      }
      res.end();
      return;
    }
    writeJson(res, 200, buildChatCompletionResponse({ model: body.model, content }));
    return;
  }

  writeJson(res, 404, { error: { message: `No route for ${method} ${url}`, type: "not_found" } });
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        reject(new ClientRequestError("Request body exceeds 4 MiB"));
        // Don't destroy the socket — let the caller write the 400 response first.
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) {
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch (error) {
        reject(new ClientRequestError(`Invalid JSON body: ${toMessage(error)}`));
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function writeSseHeaders(res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function listenOn(server: http.Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function isAddrInUse(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code: string }).code === "EADDRINUSE";
}
