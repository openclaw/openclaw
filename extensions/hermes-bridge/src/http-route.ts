import type { IncomingMessage, ServerResponse } from "node:http";
import type { HermesBridgeConfig } from "./config.js";
import { executeHermesBridgeTask } from "./executor.js";
import { createHermesBridgeResult, normalizeHermesBridgeRequest } from "./schema.js";
import type { HermesBridgeResult } from "./types.js";

type HandlerParams = {
  resolveConfig: () => HermesBridgeConfig;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  idempotencyStore?: Map<string, HermesBridgeResult>;
};

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
}

function writeJson(res: ServerResponse, statusCode: number, payload: HermesBridgeResult): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function errorResult(params: {
  status: HermesBridgeResult["status"];
  type: string;
  message: string;
}): HermesBridgeResult {
  return createHermesBridgeResult({
    ok: false,
    mode: "mock",
    status: params.status,
    summary: params.message,
    error: {
      type: params.type,
      message: params.message,
    },
  });
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      throw new Error("request_too_large");
    }
  }
  return body;
}

export function createHermesBridgeHttpHandler(params: HandlerParams) {
  const idempotencyStore = params.idempotencyStore ?? new Map<string, HermesBridgeResult>();
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const config = params.resolveConfig();
    if (!config.enabled) {
      writeJson(
        res,
        404,
        errorResult({
          status: "blocked",
          type: "disabled",
          message: "Hermes bridge is disabled.",
        }),
      );
      return true;
    }
    if (req.method !== "POST") {
      writeJson(
        res,
        405,
        errorResult({
          status: "blocked",
          type: "method_not_allowed",
          message: "Hermes bridge accepts POST requests only.",
        }),
      );
      return true;
    }

    const expectedToken = params.env?.[config.sharedSecretEnv];
    if (!expectedToken) {
      writeJson(
        res,
        503,
        errorResult({
          status: "failed",
          type: "missing_secret",
          message: `Hermes bridge token env var is not configured: ${config.sharedSecretEnv}`,
        }),
      );
      return true;
    }
    if (getHeader(req, "x-openclaw-hermes-token") !== expectedToken) {
      writeJson(
        res,
        401,
        errorResult({
          status: "blocked",
          type: "invalid_token",
          message: "Invalid Hermes bridge token.",
        }),
      );
      return true;
    }

    let parsed: unknown;
    try {
      const body = await readBody(req, config.maxRequestBytes);
      parsed = JSON.parse(body || "{}");
    } catch (error) {
      const type =
        error instanceof Error && error.message === "request_too_large"
          ? "request_too_large"
          : "invalid_json";
      writeJson(
        res,
        type === "request_too_large" ? 413 : 400,
        errorResult({
          status: "blocked",
          type,
          message:
            type === "request_too_large"
              ? "Hermes bridge request body is too large."
              : "Hermes bridge request body must be valid JSON.",
        }),
      );
      return true;
    }

    const normalized = normalizeHermesBridgeRequest(parsed);
    if (!normalized.ok) {
      writeJson(
        res,
        400,
        errorResult({
          status: "failed",
          type: normalized.error.type,
          message: normalized.error.message,
        }),
      );
      return true;
    }
    const request = normalized.request;
    if (request.idempotencyKey) {
      const cached = idempotencyStore.get(request.idempotencyKey);
      if (cached) {
        writeJson(res, cached.ok ? 200 : 409, cached);
        return true;
      }
    }

    const result = await executeHermesBridgeTask({ config, request });
    if (request.idempotencyKey) {
      idempotencyStore.set(request.idempotencyKey, result);
    }
    const statusCode = result.ok ? 200 : result.status === "needs_confirmation" ? 409 : 404;
    writeJson(res, statusCode, result);
    return true;
  };
}
