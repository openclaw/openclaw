import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import {
  resolveAgentAssistantTurnId,
  runWithAgentToolExecutionContext,
} from "../../packages/agent-core/src/tool-execution-context.js";
import { WorkerGatewayToolResultSchema } from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import {
  createCodeModeJournalStore,
  type CodeModeJournalTarget,
} from "../config/sessions/code-mode-journal.js";
import type { CodeModeSourceAssertion } from "../config/sessions/code-mode-journal.types.js";
import {
  decodeQueuedOperatorRecoverySource,
  type QueuedOperatorRecoverySource,
} from "../gateway/operator-run-recovery-source.codec.js";
import { captureQueuedOperatorRecoverySource } from "../gateway/operator-run-recovery-source.js";
import {
  readRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import { isCodeModeExecTool } from "./code-mode-control-tools.js";
import { withCodeModeDurableRecovery } from "./code-mode-durable-context.js";
import { sessionManagerReadTranscriptBranch } from "./sessions/session-manager-view-types.js";
import type { SessionManager } from "./sessions/session-manager.js";
import type { AnyAgentTool } from "./tools/common.js";

// A recovered admission retains the original source ceiling, not a newly captured
// snapshot of the current profile. The authority owner still checks current access.
const recoveredSources = new WeakMap<AdmittedRunOperatorAuthority, QueuedOperatorRecoverySource>();

export function recordCodeModeRecoveryAdmission(
  authority: AdmittedRunOperatorAuthority,
  source: QueuedOperatorRecoverySource,
): void {
  recoveredSources.set(authority, source);
}

/** Capture only the admitted turn source. Missing attribution never means session owner. */
export function captureCodeModeDurableSource(
  admission: Parameters<typeof readRunOperatorAuthority>[0],
): QueuedOperatorRecoverySource {
  const authority = readRunOperatorAuthority(admission);
  if (!authority) {
    return { kind: "unavailable", reason: "no-source" };
  }
  authority.assertCurrent();
  return (
    recoveredSources.get(authority) ??
    captureQueuedOperatorRecoverySource(authority) ?? { kind: "unavailable", reason: "no-source" }
  );
}

function decodeSource(source: CodeModeSourceAssertion): QueuedOperatorRecoverySource {
  try {
    return decodeQueuedOperatorRecoverySource(JSON.parse(source.sourceJson));
  } catch {
    throw new Error(
      "Durable Code Mode request source is invalid; explicit reconciliation is required.",
    );
  }
}

/** Read before startup admission, so the session principal cannot inherit this program. */
export async function readCodeModeDurableRecoverySource(
  target: CodeModeJournalTarget,
): Promise<QueuedOperatorRecoverySource | undefined> {
  const [first, ...remaining] = await createCodeModeJournalStore(target).list();
  if (!first) {
    return undefined;
  }
  const source = decodeSource(first.source);
  if (remaining.some((journal) => !isDeepStrictEqual(decodeSource(journal.source), source))) {
    throw new Error(
      "Durable Code Mode recovery has multiple request sources; explicit reconciliation is required.",
    );
  }
  return source;
}

/** Recover through the admitted marked control tool before any missing-result repair. */
export async function recoverCodeModeDurableExecutions(params: {
  target: CodeModeJournalTarget;
  source: QueuedOperatorRecoverySource;
  tools: readonly AnyAgentTool[];
  sessionManager: SessionManager;
  signal: AbortSignal;
}): Promise<void> {
  const store = createCodeModeJournalStore(params.target);
  const journals = await store.list();
  const admittedSource = params.source;
  for (const journal of journals) {
    params.target.assertCurrent();
    params.signal.throwIfAborted();
    const source = decodeSource(journal.source);
    if (source.kind === "unavailable" || !isDeepStrictEqual(source, admittedSource)) {
      throw new Error("Durable Code Mode recovery requires its original admitted request source.");
    }
    if (!journal.outcome) {
      const tool = params.tools.find(isCodeModeExecTool);
      if (!tool) {
        throw new Error(
          "Durable Code Mode recovery interrupted: the admitted Code Mode exec tool is unavailable.",
        );
      }
      const program: unknown = JSON.parse(journal.programJson);
      if (
        !program ||
        typeof program !== "object" ||
        !("code" in program) ||
        typeof program.code !== "string"
      ) {
        throw new Error(
          "Durable Code Mode recovery interrupted: the saved program is incompatible.",
        );
      }
      const original = params.sessionManager[sessionManagerReadTranscriptBranch]().findLast(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          (!("assistantTurnId" in program) ||
            program.assistantTurnId === undefined ||
            resolveAgentAssistantTurnId(entry.message) === program.assistantTurnId) &&
          entry.message.content.some(
            (block) => block.type === "toolCall" && block.id === journal.toolCallId,
          ),
      );
      const assistantMessage =
        original?.type === "message" && original.message.role === "assistant"
          ? original.message
          : undefined;
      const toolCall = assistantMessage?.content.find(
        (block) => block.type === "toolCall" && block.id === journal.toolCallId,
      );
      if (!assistantMessage || toolCall?.type !== "toolCall") {
        throw new Error(
          "Durable Code Mode recovery interrupted: the original assistant tool call is unavailable.",
        );
      }
      await runWithAgentToolExecutionContext({ assistantMessage, toolCall }, () =>
        withCodeModeDurableRecovery(journal, () =>
          tool.execute(
            journal.toolCallId,
            { code: program.code, awaitResults: true },
            params.signal,
          ),
        ),
      );
    }
    // The host commits the exact terminal result before returning. A waiting cell
    // is not a completed recovery and must not be replaced with a synthetic result.
    const completed = journal.outcome ? journal : await store.read(journal.executionId);
    if (!completed?.outcome) {
      throw new Error(
        "Durable Code Mode recovery did not reach a terminal result; its journal was preserved.",
      );
    }
    const result: unknown = JSON.parse(completed.outcome.resultJson);
    if (!Value.Check(WorkerGatewayToolResultSchema, result)) {
      throw new Error(
        "Durable Code Mode recovery has an invalid terminal result; its journal was preserved.",
      );
    }
    params.target.assertCurrent();
    await params.sessionManager.appendMessageAsync({
      role: "toolResult",
      toolCallId: journal.toolCallId,
      toolName: "exec",
      ...result,
      isError: result.isError ?? false,
      timestamp: Date.now(),
    });
    // The transcript owner retires this journal in the append transaction.
  }
}
