import type { IncomingMessage, ServerResponse } from "node:http";
import type { CodexContinuityBridge } from "./bridge.js";
import { redactCodexBridgeJson } from "./redaction.js";
import type { CodexBridgeWriteRequest } from "./types.js";

export function registerCodexContinuityHttpRoutes(params: {
  registerHttpRoute: (route: {
    path: string;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
    replaceExisting?: boolean;
    gatewayRuntimeScopeSurface?: "trusted-operator" | "write-default";
    handler: (
      req: IncomingMessage,
      res: ServerResponse,
    ) => Promise<boolean | void> | boolean | void;
  }) => void;
  bridge: CodexContinuityBridge;
}): void {
  const route = (
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>,
  ) =>
    params.registerHttpRoute({
      path,
      auth: "gateway",
      match: "exact",
      replaceExisting: true,
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: async (req, res) => writeJson(res, await handler(req, res)),
    });

  route("/codex/status", async () => {
    const snapshot = await params.bridge.snapshot();
    return redactCodexBridgeJson({
      ok: snapshot.ok,
      source: snapshot.source,
      stale: snapshot.stale,
      observedAt: snapshot.observedAt,
      appServerStatus: snapshot.appServerStatus,
      activeThreads: snapshot.activeThreads.map(publicThread),
      latestThread: snapshot.latestThread ? publicThread(snapshot.latestThread) : undefined,
      threadCount: snapshot.threads.length,
      watchCount: snapshot.watches.length,
      warnings: snapshot.warnings,
      lastTelegramFailure: snapshot.lastTelegramFailure,
    });
  });
  route("/codex/threads", async () => {
    const snapshot = await params.bridge.snapshot();
    return {
      ok: snapshot.ok,
      source: snapshot.source,
      stale: snapshot.stale,
      observedAt: snapshot.observedAt,
      threads: redactCodexBridgeJson(snapshot.threads.map(publicThread)),
      warnings: snapshot.warnings,
    };
  });
  route("/codex/watch", async (req) => {
    if (req.method !== "POST") {
      return { ok: false, error: "POST required" };
    }
    const body = await readJsonBody(req);
    return {
      ok: true,
      watch: await params.bridge.registerWatch({
        threadId: readString(body.threadId),
        repoPath: readString(body.repoPath),
        goalKey: readString(body.goalKey),
        notifyTarget: readString(body.notifyTarget),
        notifyChannel: readString(body.notifyChannel),
        notifyAccountId: readString(body.notifyAccountId),
        notifyThreadId: readString(body.notifyThreadId),
        createdBy: readString(body.createdBy) ?? "gateway",
        sensitivity: readEnum(body.sensitivity, ["normal", "sensitive", "no_telegram_details"]),
        verbosity: readEnum(body.verbosity, [
          "completion_only",
          "blockers_and_completion",
          "periodic_digest",
        ]),
        ttlMs: readNumber(body.ttlMs),
      }),
    };
  });
  route("/codex/watch/check", async () => ({
    ok: true,
    result: await params.bridge.checkWatches({ backfill: false }),
  }));
  route("/codex/handoff", async (req) => {
    const body = req.method === "POST" ? await readJsonBody(req) : {};
    return {
      ok: true,
      brief: await params.bridge.handoff(readString(body.threadId)),
    };
  });
  route("/codex/goal", async (req) => {
    if (req.method !== "POST") {
      return { ok: false, error: "POST required" };
    }
    const body = await readJsonBody(req);
    const request = readWriteRequest(body, "goal");
    const result = await params.bridge.submitWriteRequest(request);
    return { ok: result.ok, result };
  });
  route("/codex/steer", async (req) => {
    if (req.method !== "POST") {
      return { ok: false, error: "POST required" };
    }
    const body = await readJsonBody(req);
    const request = readWriteRequest(body, "steer");
    const result = await params.bridge.submitWriteRequest(request);
    return { ok: result.ok, result };
  });
}

function readWriteRequest(
  body: Record<string, unknown>,
  action: CodexBridgeWriteRequest["action"],
): CodexBridgeWriteRequest {
  return {
    action,
    prompt: readString(body.prompt) ?? readString(body.goal) ?? readString(body.message) ?? "",
    threadId: readString(body.threadId),
    turnId: readString(body.turnId),
    repoPath: readString(body.repoPath),
    requestedBySenderId: readString(body.requestedBySenderId),
    provenance: isRecord(body.provenance)
      ? {
          requestedBy: readString(body.provenance.requestedBy),
          requestId: readString(body.provenance.requestId),
          sourceMessageId: readString(body.provenance.sourceMessageId),
          confirmed:
            typeof body.provenance.confirmed === "boolean" ? body.provenance.confirmed : undefined,
          confirmationMethod: readString(body.provenance.confirmationMethod),
          riskClass: readEnum(body.provenance.riskClass, ["low", "medium", "high"]),
          createdAt: readString(body.provenance.createdAt),
        }
      : undefined,
  };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJson(res: ServerResponse, payload: unknown): true {
  const body = JSON.stringify(payload, null, 2);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(body);
  return true;
}

function publicThread<T extends { raw?: unknown }>(thread: T): Omit<T, "raw"> {
  const { raw: _raw, ...publicValue } = thread;
  return publicValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : undefined;
}
