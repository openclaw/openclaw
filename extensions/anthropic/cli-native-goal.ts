import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type {
  AgentHarnessNativeGoal,
  CliBackendExecuteContext,
} from "openclaw/plugin-sdk/cli-backend";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_RESTRICTED_SETTINGS } from "./cli-shared.js";
import { listClaudeSessions } from "./session-catalog-discovery.js";
import { resolveClaudeCatalogHomeDir } from "./session-catalog-home.js";

type GoalStatus = {
  condition: string;
  met: boolean;
  failed?: boolean;
  sentinel?: boolean;
  reason?: string;
};

function readGoalStatus(row: unknown, sessionId: string): GoalStatus | undefined {
  if (
    !isRecord(row) ||
    row.sessionId !== sessionId ||
    row.isSidechain === true ||
    row.type !== "attachment" ||
    !isRecord(row.attachment)
  ) {
    return undefined;
  }
  const status = row.attachment;
  if (
    status.type !== "goal_status" ||
    typeof status.condition !== "string" ||
    typeof status.met !== "boolean"
  ) {
    return undefined;
  }
  return {
    condition: status.condition,
    met: status.met,
    failed: status.failed === true,
    sentinel: status.sentinel === true,
    ...(typeof status.reason === "string" ? { reason: status.reason } : {}),
  };
}

async function readRestoredGoal(
  context: CliBackendExecuteContext,
): Promise<GoalStatus | undefined> {
  if (!context.useResume || !context.sessionId) {
    return undefined;
  }
  const catalog = await listClaudeSessions(resolveClaudeCatalogHomeDir(context.env), {
    configDir: context.env.CLAUDE_CONFIG_DIR,
    includeDesktop: false,
    sessionId: context.sessionId,
    forceRefresh: true,
  });
  const record = catalog.records.find((entry) => entry.threadId === context.sessionId);
  if (catalog.truncated || !record) {
    throw new Error("Claude native goal resume could not verify the existing native session.");
  }
  // Use the catalog's canonical, containment-checked native transcript, not a path
  // supplied by model output. Read the whole metadata history: a tail can miss a clear.
  const input = createReadStream(record.filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let latest: GoalStatus | undefined;
  try {
    for await (const line of lines) {
      context.assertCurrent?.();
      context.abortSignal?.throwIfAborted();
      if (!line.trim()) {
        continue;
      }
      const status = readGoalStatus(JSON.parse(line), context.sessionId);
      if (status) {
        latest = status;
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return latest;
}

export type ClaudeNativeGoal = {
  signal: AbortSignal;
  input: string;
  /** Initial /goal replaces only the command input; preserve the original turn context. */
  startsGoal: boolean;
  stop(): { continue?: false; stopReason?: string };
  observe(message: Record<string, unknown>): void;
  finish(result: Record<string, unknown>): Promise<void>;
};

/** Claude owns its Stop-hook loop inside one stdio invocation, never a host prompt loop. */
export async function prepareClaudeNativeGoal(
  context: CliBackendExecuteContext,
): Promise<ClaudeNativeGoal | undefined> {
  const goal = await context.prepareNativeGoal?.();
  if (!goal) {
    return undefined;
  }
  if (
    !context.sessionId ||
    context.args.some(
      (arg) =>
        arg === "--fork-session" ||
        arg === "--resume-session-at" ||
        arg.startsWith("--resume-session-at="),
    )
  ) {
    throw new Error("Claude native goals require a bound session without a fork or rewind.");
  }
  if (goal.tokenBudget !== undefined) {
    throw new Error(
      "Claude native goals do not support an exact token budget; the budget was not discarded.",
    );
  }
  if (
    !goal.objective.trim() ||
    goal.objective.length > 4000 ||
    /^(?:clear|stop|off|reset|none|cancel)$/iu.test(goal.objective.trim())
  ) {
    throw new Error(
      "The goal cannot be represented by Claude's native /goal command without changing it.",
    );
  }
  const restored = await readRestoredGoal(context);
  goal.assertCurrent();
  const active = restored && !restored.met && !restored.failed;
  if (active && restored.condition !== goal.objective) {
    throw new Error("The bound Claude session has a different native goal; it was not replaced.");
  }
  let latest: GoalStatus | undefined;
  const sessionId = context.sessionId;
  return {
    signal: goal.signal,
    input: active ? context.prompt : `/goal ${goal.objective}`,
    startsGoal: !active,
    stop() {
      goal.assertCurrent();
      // Stop runs after the current answer. Native continue:false wins over an
      // unmet prompt hook without interrupting that answer or aborting its owner.
      return goal.readToolStatus?.()
        ? { continue: false, stopReason: "The OpenClaw Goal tool committed a terminal verdict." }
        : {};
    },
    observe(message) {
      if (message.type !== "transcript_mirror" || !Array.isArray(message.entries)) {
        return;
      }
      for (const row of message.entries) {
        const status = readGoalStatus(row, sessionId);
        if (status) {
          latest = status;
        }
      }
    },
    async finish(result) {
      goal.assertCurrent();
      // The run's managed MCP tool already committed its verdict. Native mirror state
      // may lag or be absent; it must not overwrite that result or demand another loop.
      if (goal.readToolStatus?.()) {
        return;
      }
      if (result.is_error === true || result.subtype !== "success") {
        await goal.onStatus({
          status: "paused",
          reason: "Claude's native pursuit ended with an invocation error.",
        });
        return;
      }
      if (!latest || latest.condition !== goal.objective) {
        throw new Error(
          "Claude ended without a confirmed native goal verdict; the goal was not marked complete.",
        );
      }
      const status: Parameters<AgentHarnessNativeGoal["onStatus"]>[0]["status"] = latest.failed
        ? "blocked"
        : latest.met && !latest.sentinel
          ? "complete"
          : "paused";
      await goal.onStatus({
        status,
        reason:
          latest.reason ??
          (status === "paused"
            ? "Claude's native pursuit stopped before confirming the goal."
            : undefined),
      });
    },
  };
}

export function prepareClaudeNativeGoalArgs(args: readonly string[]): string[] {
  // --disable-slash-commands also disables the built-in /goal. Empty settings
  // sources still exclude project/user skills; disable bundled skills separately.
  // Only replace the restriction authored by this plugin, never an operator policy.
  const settings = JSON.stringify({
    ...JSON.parse(CLAUDE_RESTRICTED_SETTINGS),
    disableAllHooks: false,
    hooks: {},
    disableBundledSkills: true,
    disableSkillShellExecution: true,
  });
  return [
    ...args
      .filter((arg) => arg !== "--disable-slash-commands")
      .map((arg) => (arg === CLAUDE_RESTRICTED_SETTINGS ? settings : arg)),
    "--session-mirror",
  ];
}
