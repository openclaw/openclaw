import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createPersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";

const GUARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MEMORY_MAX_SIZE = 5_000;
const FILE_MAX_ENTRIES = 20_000;
const SUPPRESSED_MESSAGE_ID = "openclaw-runtime-comms-guard-suppressed";
const DEDUPED_MESSAGE_ID = "openclaw-runtime-comms-guard-deduped";

export type TelegramRuntimeCommsGuardContext = {
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

export type TelegramRuntimeCommsGuardDeliveryResult = {
  messageId: string;
  chatId: string;
};

function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
  if (stateOverride) {
    return stateOverride;
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), ["openclaw-vitest", String(process.pid)].join("-"));
  }
  return path.join(os.homedir(), ".openclaw");
}

function safeNamespace(namespace: string): string {
  return namespace.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeText(value: string | undefined | null): string {
  return compactText(value ?? "");
}

function resolveGuardNamespace(params: TelegramRuntimeCommsGuardContext): string {
  return `outbound_${sha256({
    channel: "telegram",
    accountId: params.accountId ?? "default",
    to: params.to,
    threadId: params.threadId ?? null,
  }).slice(0, 32)}`;
}

function resolveGuardLedgerPath(namespace: string): string {
  return path.join(
    resolveStateDir(),
    "telegram",
    "runtime-comms-guard",
    `${safeNamespace(namespace)}.json`,
  );
}

const persistentGuardLedger = createPersistentDedupe({
  ttlMs: GUARD_TTL_MS,
  memoryMaxSize: MEMORY_MAX_SIZE,
  fileMaxEntries: FILE_MAX_ENTRIES,
  resolveFilePath: resolveGuardLedgerPath,
});

function isJsonDump(text: string): boolean {
  const trimmed = text.trim();
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function classifyTelegramRuntimeCommsText(
  text: string | undefined | null,
): "progress" | "technical" | "final" | null {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }
  if (/^(Идет работа\.|Идёт работа\.)$/iu.test(normalized)) {
    return "progress";
  }
  if (isJsonDump(text ?? "")) {
    return "technical";
  }
  const technicalPatterns = [
    /^MODEL-GATE\b/im,
    /^task_type:/im,
    /^risk_level:/im,
    /^recommended_model:/im,
    /^recommended_reasoning:/im,
    /^current_model_sufficient:/im,
    /^cheaper_safe_alternative:/im,
    /^proceed_status:/im,
    /^Working[.….]*$/i,
    /^Gateway restart\b/i,
    /^Reason:\s+/i,
    /^Run:\s+/i,
    /^Command exited with code\s+\d+/i,
    /^Command still running\b/i,
    /^Service:\s+LaunchAgent\b/i,
    /^Gateway:\s+bind=/i,
    /^Runtime:\s+running\b/i,
    /^Connectivity probe:\s+/i,
    /^Recommendation:\s+run\s+"?openclaw doctor/i,
    /^Troubleshooting:\s+https?:\/\//i,
    /^\$\s*openclaw\b/i,
    /^openclaw\s+(gateway|doctor|status|models)\b/i,
    /\bopenclaw doctor\b/i,
    /\b(openclaw gateway status|openclaw doctor|gateway restart)\b/i,
    /\b(stdout|stderr|runId|threadId|messageId|stack trace|Traceback)\b/i,
    /\b(command|exec|tool output)\b/i,
    /\bat\s+\S+\s*\([^)]*:\d+:\d+\)/,
    /\b[0-9a-f]{40,64}\b.*\b(SHA|sha|bytes?|byte counts?)\b/i,
    /\b(SHA|sha|bytes?|byte counts?)\b.*\b[0-9a-f]{40,64}\b/i,
    /\b(SHA dumps?|byte counts?)\b/i,
  ];
  if (technicalPatterns.some((pattern) => pattern.test(normalized))) {
    return "technical";
  }
  if (/^Статус:\s+/i.test(normalized) || /^Status:\s+/i.test(normalized)) {
    return "final";
  }
  return null;
}

export function runtimeCommsGuardSuppressedResult(
  to: string,
  duplicate = false,
): TelegramRuntimeCommsGuardDeliveryResult {
  return {
    messageId: duplicate ? DEDUPED_MESSAGE_ID : SUPPRESSED_MESSAGE_ID,
    chatId: to,
  };
}

export async function shouldSendTelegramRuntimeCommsText(params: {
  context: TelegramRuntimeCommsGuardContext;
  text: string | undefined | null;
  now?: number;
}): Promise<boolean> {
  const classification = classifyTelegramRuntimeCommsText(params.text);
  if (classification === "technical") {
    return false;
  }
  if (classification !== "progress" && classification !== "final") {
    return true;
  }
  const key = sha256({
    kind: classification,
    text: normalizeText(params.text),
  });
  return await persistentGuardLedger.checkAndRecord(key, {
    namespace: resolveGuardNamespace(params.context),
    now: params.now,
  });
}

function shouldDedupeTelegramRuntimeCommsMedia(mediaUrl: string): boolean {
  if (!mediaUrl) {
    return false;
  }
  if (/^(file:\/\/|\/|~\/)/i.test(mediaUrl)) {
    return true;
  }
  if (/\b(report|artifact|отчет|отчёт)\b/i.test(mediaUrl)) {
    return true;
  }
  return /\.(txt|md|json|log|csv)(?:[?#].*)?$/i.test(mediaUrl);
}

export async function shouldSendTelegramRuntimeCommsMedia(params: {
  context: TelegramRuntimeCommsGuardContext;
  mediaUrl: string | undefined | null;
  purpose?: "file" | "media";
  now?: number;
}): Promise<boolean> {
  const mediaUrl = normalizeText(params.mediaUrl);
  if (!shouldDedupeTelegramRuntimeCommsMedia(mediaUrl)) {
    return true;
  }
  const key = sha256({ kind: params.purpose ?? "file", mediaUrl });
  return await persistentGuardLedger.checkAndRecord(key, {
    namespace: resolveGuardNamespace(params.context),
    now: params.now,
  });
}

export function clearTelegramRuntimeCommsGuardMemoryForTests(): void {
  persistentGuardLedger.clearMemory();
}
