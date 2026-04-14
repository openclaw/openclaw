import type { PluginCommandContext } from "../../../src/plugins/types.js";
import { executeQueuedRun } from "./run-execution.js";
import { formatRunId, writeRunRecord } from "./run-store.js";
import type { RunKind, RunRecord } from "./run-types.js";

const MAX_RUN_TEXT_LENGTH = 500;

const RUN_HELP_TEXT = [
  "OpenClaw run commands",
  "Current MVP stores queued runs only.",
  "- /openclaw run help",
  "- /openclaw run health",
  "- /openclaw run digest",
  "- /openclaw run <free-text>",
].join("\n");

type RunCommandParseResult =
  | {
      kind: "help";
      text: string;
    }
  | {
      kind: "error";
      text: string;
    }
  | {
      kind: "pending";
      rawText: string;
      runKind: RunKind;
      normalizedTask: string;
      params: Record<string, unknown>;
    };

type BuildQueuedRunRecordResult =
  | Extract<RunCommandParseResult, { kind: "help" | "error" }>
  | {
      kind: "queued";
      record: RunRecord;
    };

function deriveChannelId(ctx: Pick<PluginCommandContext, "to">): string | null {
  const candidate = typeof ctx.to === "string" ? ctx.to.trim() : "";
  return candidate || null;
}

function classifyRunCommand(args: string | undefined): RunCommandParseResult {
  const trimmed = args?.trim() ?? "";
  if (!trimmed || trimmed.toLowerCase() === "help") {
    return { kind: "help", text: RUN_HELP_TEXT };
  }
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    return { kind: "error", text: "入力が無効です: 改行は使えません" };
  }
  if (trimmed.length > MAX_RUN_TEXT_LENGTH) {
    return { kind: "error", text: `入力が無効です: 最大 ${MAX_RUN_TEXT_LENGTH} 文字です` };
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === "health") {
    return {
      kind: "pending",
      rawText: trimmed,
      runKind: "health",
      normalizedTask: "health",
      params: {},
    };
  }
  if (normalized === "digest") {
    return {
      kind: "pending",
      rawText: trimmed,
      runKind: "digest",
      normalizedTask: "digest",
      params: {},
    };
  }
  if (normalized.startsWith("job ") || normalized === "job") {
    return { kind: "error", text: "まだ未実装です: /openclaw run job <run_id>" };
  }
  if (normalized.startsWith("list") || normalized.startsWith("retry ")) {
    return { kind: "error", text: "まだ未実装です: list/retry は次のPRで追加します" };
  }

  return {
    kind: "pending",
    rawText: trimmed,
    runKind: "free",
    normalizedTask: trimmed,
    params: {},
  };
}

export function buildQueuedRunRecord(params: {
  args: string | undefined;
  ctx: Pick<PluginCommandContext, "senderId" | "from" | "to" | "messageThreadId">;
  now?: Date;
  runId?: string;
}): BuildQueuedRunRecordResult {
  const parsed = classifyRunCommand(params.args);
  if (parsed.kind !== "pending") {
    return parsed;
  }

  const now = params.now ?? new Date();
  const queuedAt = now.toISOString();
  const runId = params.runId ?? formatRunId(now);
  const requestedBy =
    (typeof params.ctx.senderId === "string" && params.ctx.senderId.trim()) || "unknown";
  const requestedByName =
    typeof params.ctx.from === "string" && params.ctx.from.trim() ? params.ctx.from.trim() : null;

  return {
    kind: "queued",
    record: {
      run_id: runId,
      requested_by: requestedBy,
      requested_by_name: requestedByName,
      channel_id: deriveChannelId(params.ctx),
      channel_name: null,
      raw_text: parsed.rawText,
      kind: parsed.runKind,
      normalized_task: parsed.normalizedTask,
      params: parsed.params,
      status: "queued",
      sense_job_id: null,
      queued_at: queuedAt,
      started_at: null,
      done_at: null,
      result: null,
      error: null,
      retry_of: null,
      retry_count: 0,
      slack_ts:
        params.ctx.messageThreadId == null
          ? null
          : String(params.ctx.messageThreadId).trim() || null,
    },
  };
}

export async function handleRunCommand(
  ctx: PluginCommandContext,
  deps: {
    now?: () => Date;
    writeRecord?: typeof writeRunRecord;
    executeRun?: typeof executeQueuedRun;
  } = {},
): Promise<{ text: string }> {
  const built = buildQueuedRunRecord({
    args: ctx.args,
    ctx,
    now: deps.now?.(),
  });

  if (built.kind !== "queued") {
    return { text: built.text };
  }

  const writeRecord = deps.writeRecord ?? writeRunRecord;
  await writeRecord(built.record);
  const executeRun = deps.executeRun ?? executeQueuedRun;
  void executeRun(built.record, { config: ctx.config }).catch((error) => {
    console.error("[sense-worker] run execution failed", error);
  });

  return {
    text: [
      "受付しました",
      `run_id: \`${built.record.run_id}\``,
      `タスク: \`${built.record.kind}\``,
      `状態: \`${built.record.status}\``,
    ].join("\n"),
  };
}

export const __testing = {
  classifyRunCommand,
  RUN_HELP_TEXT,
  deriveChannelId,
};
