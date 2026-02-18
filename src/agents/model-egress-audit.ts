import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";

export type ModelEgressAuditEvent = {
  ts: string;
  stage: "request" | "chunk" | "response" | "error";
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  payload?: unknown;
  chunk?: unknown;
  response?: unknown;
  error?: string;
};

type AuditCfg = {
  enabled: boolean;
  filePath: string;
};

type Writer = {
  filePath: string;
  write: (line: string) => void;
};

const writers = new Map<string, Writer>();

function resolveCfg(env: NodeJS.ProcessEnv): AuditCfg {
  const enabled = parseBooleanValue(env.OPENCLAW_MODEL_EGRESS_AUDIT) ?? false;
  const fileOverride = env.OPENCLAW_MODEL_EGRESS_AUDIT_FILE?.trim();
  const filePath = fileOverride
    ? resolveUserPath(fileOverride)
    : path.join(resolveStateDir(env), "logs", "audit", "model-egress-%DATE%.jsonl");

  if (filePath.includes("%DATE%")) {
    const d = new Date();
    const yyyy = String(d.getFullYear());
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return { enabled, filePath: filePath.replaceAll("%DATE%", `${yyyy}-${mm}-${dd}`) };
  }

  return { enabled, filePath };
}

function getWriter(filePath: string): Writer {
  const existing = writers.get(filePath);
  if (existing) {
    return existing;
  }

  const dir = path.dirname(filePath);
  const ready = fs.mkdir(dir, { recursive: true }).catch(() => undefined);
  let queue = Promise.resolve();

  const writer: Writer = {
    filePath,
    write: (line: string) => {
      queue = queue
        .then(() => ready)
        .then(() => fs.appendFile(filePath, line, "utf8"))
        .catch(() => undefined);
    },
  };

  writers.set(filePath, writer);
  return writer;
}

function safeJsonStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") {
        return val.toString();
      }
      if (typeof val === "function") {
        return "[Function]";
      }
      if (val instanceof Error) {
        return { name: val.name, message: val.message, stack: val.stack };
      }
      if (val instanceof Uint8Array) {
        return { type: "Uint8Array", data: Buffer.from(val).toString("base64") };
      }
      return val;
    });
  } catch {
    return null;
  }
}

function formatError(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  if (error && typeof error === "object") {
    return safeJsonStringify(error) ?? "unknown error";
  }
  return undefined;
}

export type ModelEgressAuditor = {
  enabled: true;
  recordRequest: (payload: unknown) => void;
  recordChunk: (chunk: unknown) => void;
  recordResponse: (response: unknown) => void;
  recordError: (error: unknown) => void;
};

export function createModelEgressAuditor(params: {
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
}): ModelEgressAuditor | null {
  const env = params.env ?? process.env;
  const cfg = resolveCfg(env);
  if (!cfg.enabled) {
    return null;
  }

  const writer = getWriter(cfg.filePath);
  const base: Omit<ModelEgressAuditEvent, "ts" | "stage"> = {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    workspaceDir: params.workspaceDir,
  };

  const writeEvent = (evt: ModelEgressAuditEvent) => {
    const line = safeJsonStringify(evt);
    if (!line) {
      return;
    }
    writer.write(`${line}\n`);
  };

  return {
    enabled: true,
    recordRequest: (payload) =>
      writeEvent({ ...base, ts: new Date().toISOString(), stage: "request", payload }),
    recordChunk: (chunk) =>
      writeEvent({ ...base, ts: new Date().toISOString(), stage: "chunk", chunk }),
    recordResponse: (response) =>
      writeEvent({ ...base, ts: new Date().toISOString(), stage: "response", response }),
    recordError: (error) =>
      writeEvent({
        ...base,
        ts: new Date().toISOString(),
        stage: "error",
        error: formatError(error),
      }),
  };
}
