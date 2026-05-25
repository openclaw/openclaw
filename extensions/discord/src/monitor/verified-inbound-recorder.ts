import { spawn } from "node:child_process";

// Best-effort, config-gated provenance hook. When an external recorder command is
// configured via env, inbound Discord human messages that already passed
// preflight/access gating are forwarded as a single JSON provenance row on stdin.
// This records *that an inbound message was verified*; it never asserts any gate
// decision or approval trace. Disabled unless OPENCLAW_VERIFIED_INBOUND_RECORDER_CMD
// is set, so upstream behavior is unchanged by default.

const DEFAULT_TENANT_ID = "johnny";
const RECORDER_TIMEOUT_MS = 5_000;

export type VerifiedInboundRecord = {
  tenant_id: string;
  source_channel: "discord";
  source_message_id: string;
  source_sender_id: string;
  raw_text: string;
  provider: string;
  channel: string;
  surface: string;
  recorded_at: string;
};

export type VerifiedInboundRecorderConfig = {
  command: string;
  args: string[];
  tenantId: string;
  require: boolean;
};

type RecorderEnv = Record<string, string | undefined>;

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseRecorderArgs(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return [];
  }
  // Prefer an explicit JSON array so args carrying spaces stay intact; fall back
  // to whitespace splitting for the simple single-token case.
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
        return parsed;
      }
    } catch {
      // fall through to whitespace splitting
    }
  }
  return trimmed.split(/\s+/);
}

/**
 * Resolve recorder config from env. Returns undefined (no-op) when no command is
 * configured, which keeps default Discord behavior untouched.
 */
export function resolveVerifiedInboundRecorderConfig(
  env: RecorderEnv,
): VerifiedInboundRecorderConfig | undefined {
  const command = env.OPENCLAW_VERIFIED_INBOUND_RECORDER_CMD?.trim();
  if (!command) {
    return undefined;
  }
  return {
    command,
    args: parseRecorderArgs(env.OPENCLAW_VERIFIED_INBOUND_RECORDER_ARGS),
    tenantId: env.OPENCLAW_VERIFIED_INBOUND_TENANT?.trim() || DEFAULT_TENANT_ID,
    require: isTruthyFlag(env.OPENCLAW_VERIFIED_INBOUND_REQUIRE),
  };
}

/**
 * Build the provenance row. Returns undefined when required identity/text is
 * missing so empty inbound text is never recorded.
 */
export function buildVerifiedInboundRecord(params: {
  tenantId: string;
  sourceMessageId?: string;
  sourceSenderId?: string;
  rawText?: string;
  provider?: string;
  channel?: string;
  surface?: string;
  now?: () => Date;
}): VerifiedInboundRecord | undefined {
  const sourceMessageId = params.sourceMessageId?.trim();
  const sourceSenderId = params.sourceSenderId?.trim();
  const rawText = params.rawText;
  if (!sourceMessageId || !sourceSenderId || !rawText || !rawText.trim()) {
    return undefined;
  }
  const now = params.now ?? (() => new Date());
  return {
    tenant_id: params.tenantId,
    source_channel: "discord",
    source_message_id: sourceMessageId,
    source_sender_id: sourceSenderId,
    raw_text: rawText,
    provider: params.provider ?? "discord",
    channel: params.channel ?? "discord",
    surface: params.surface ?? "discord",
    recorded_at: now().toISOString(),
  };
}

export type SpawnRecorder = typeof spawn;

export function selectVerifiedInboundRawText(
  ...candidates: Array<string | undefined>
): string | undefined {
  for (const candidate of candidates) {
    if (candidate && candidate.trim()) {
      return candidate;
    }
  }
  return candidates.find((candidate) => candidate !== undefined);
}

/**
 * Invoke the external recorder, writing the record as JSON to stdin. Uses spawn
 * with an explicit argv (never a shell) to avoid injection. Resolves on exit 0;
 * rejects on spawn error, nonzero exit, or timeout.
 */
export async function invokeVerifiedInboundRecorder(params: {
  config: VerifiedInboundRecorderConfig;
  record: VerifiedInboundRecord;
  spawnImpl?: SpawnRecorder;
  timeoutMs?: number;
}): Promise<void> {
  const spawnImpl = params.spawnImpl ?? spawn;
  const timeoutMs = params.timeoutMs ?? RECORDER_TIMEOUT_MS;
  const payload = `${JSON.stringify(params.record)}\n`;

  await new Promise<void>((resolve, reject) => {
    const child = spawnImpl(params.config.command, params.config.args, {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let settled = false;
    let stderr = "";
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`verified inbound recorder timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    const finish = (err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 4_096) {
        stderr += String(chunk);
      }
    });
    child.on("error", (err: Error) => finish(err));
    child.on("close", (code: number | null) => {
      if (code === 0) {
        finish();
      } else {
        finish(new Error(`verified inbound recorder exited ${code ?? "null"}: ${stderr.trim()}`));
      }
    });

    child.stdin?.on("error", () => {
      // stdin EPIPE is surfaced via the close/error handlers; swallow here.
    });
    child.stdin?.end(payload);
  });
}

/**
 * High-level entry: resolve config, build record, invoke recorder. Best-effort by
 * default — logs and continues on failure. Throws only when the recorder is both
 * configured and marked required (OPENCLAW_VERIFIED_INBOUND_REQUIRE), so a failing
 * required recorder blocks the inbound turn fail-closed.
 */
export async function recordVerifiedInboundMessage(params: {
  env: RecorderEnv;
  sourceMessageId?: string;
  sourceSenderId?: string;
  rawText?: string;
  provider?: string;
  channel?: string;
  surface?: string;
  spawnImpl?: SpawnRecorder;
  log?: (message: string) => void;
  now?: () => Date;
}): Promise<void> {
  const config = resolveVerifiedInboundRecorderConfig(params.env);
  if (!config) {
    return;
  }
  const record = buildVerifiedInboundRecord({
    tenantId: config.tenantId,
    sourceMessageId: params.sourceMessageId,
    sourceSenderId: params.sourceSenderId,
    rawText: params.rawText,
    provider: params.provider,
    channel: params.channel,
    surface: params.surface,
    now: params.now,
  });
  if (!record) {
    if (config.require) {
      throw new Error("verified inbound recorder required but inbound record was incomplete");
    }
    params.log?.("discord: skip verified inbound record (incomplete provenance fields)");
    return;
  }
  try {
    await invokeVerifiedInboundRecorder({
      config,
      record,
      spawnImpl: params.spawnImpl,
    });
  } catch (err) {
    if (config.require) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    params.log?.(`discord: verified inbound recorder failed (continuing): ${String(err)}`);
  }
}
