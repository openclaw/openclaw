import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  readJsonBodyWithLimit,
  requestBodyErrorToText,
  type ChannelAccountSnapshot,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import { processNapCatEvent } from "./inbound.js";
import type { OneBotMessageEvent, ResolvedNapCatAccount } from "./types.js";

export const NAPCAT_HTTP_LIVENESS_INTERVAL_MS = 5 * 60_000;

function resolvePathname(req: IncomingMessage): string {
  try {
    const base = `http://${req.headers.host || "localhost"}`;
    return new URL(req.url || "/", base).pathname;
  } catch {
    return "";
  }
}

function getTokenFromRequest(req: IncomingMessage): string | undefined {
  const auth = String(req.headers.authorization ?? "");
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  const accessToken = req.headers["x-access-token"];
  if (typeof accessToken === "string" && accessToken.trim()) {
    return accessToken.trim();
  }
  const selfToken = req.headers["x-self-token"];
  if (typeof selfToken === "string" && selfToken.trim()) {
    return selfToken.trim();
  }
  try {
    const base = `http://${req.headers.host || "localhost"}`;
    const queryToken = new URL(req.url || "/", base).searchParams.get("access_token");
    return queryToken?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function writeJson(res: ServerResponse, status: number, payload: Record<string, unknown>) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

export type NapCatHttpMonitorOptions = {
  account: ResolvedNapCatAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
};

export type NapCatHttpMonitorHandle = {
  stop: () => Promise<void>;
};

export async function startNapCatHttpMonitor(
  options: NapCatHttpMonitorOptions,
): Promise<NapCatHttpMonitorHandle> {
  const host = options.account.transport.http.host;
  const port = options.account.transport.http.port;
  const path = options.account.transport.http.path;

  const server = createServer(async (req, res) => {
    if (resolvePathname(req) !== path) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (!options.account.token) {
      writeJson(res, 500, { error: "napcat token missing" });
      return;
    }
    const token = getTokenFromRequest(req);
    if (!token || token !== options.account.token) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    const body = await readJsonBodyWithLimit(req, {
      maxBytes: options.account.transport.http.bodyMaxBytes,
      timeoutMs: 30_000,
      emptyObjectOnEmpty: false,
    });
    if (!body.ok) {
      const status =
        body.code === "PAYLOAD_TOO_LARGE" ? 413 : body.code === "REQUEST_BODY_TIMEOUT" ? 408 : 400;
      const errorText =
        body.code === "INVALID_JSON" ? "invalid json payload" : requestBodyErrorToText(body.code);
      writeJson(res, status, { error: errorText });
      return;
    }
    if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
      writeJson(res, 400, { error: "invalid payload" });
      return;
    }

    const event = body.value as OneBotMessageEvent;
    void processNapCatEvent({
      event,
      account: options.account,
      config: options.config,
      runtime: options.runtime,
      statusSink: options.statusSink,
    }).catch((err) => {
      options.runtime.error?.(`[napcat] inbound http processing failed: ${String(err)}`);
    });

    writeJson(res, 200, { ok: true });
  });

  await new Promise<void>((resolve, reject) => {
    const onListen = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      server.off("listening", onListen);
      reject(err);
    };
    server.once("error", onError);
    server.listen(port, host, onListen);
  });
  const emitLiveness = () => {
    // HTTP webhook delivery is passive, so synthesize a liveness tick while the
    // listener is idle to avoid false stale-socket restarts.
    options.statusSink?.({ lastEventAt: Date.now() });
  };
  const livenessTimer = setInterval(emitLiveness, NAPCAT_HTTP_LIVENESS_INTERVAL_MS);
  livenessTimer.unref?.();
  const stopLivenessTimer = () => clearInterval(livenessTimer);
  const connectedAt = Date.now();
  options.statusSink?.({
    connected: true,
    lastConnectedAt: connectedAt,
    lastEventAt: connectedAt,
    lastError: null,
  });

  server.on("error", (err) => {
    stopLivenessTimer();
    options.statusSink?.({
      connected: false,
      lastError: String(err),
    });
  });
  server.on("close", stopLivenessTimer);

  return {
    stop: async () => {
      stopLivenessTimer();
      await closeServer(server);
      options.statusSink?.({ connected: false });
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
