import type { CliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import type { CompactionAccountingTarget } from "../embedded-agent-runner/run/internal-params.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner/types.js";

const settledWriters = new WeakMap<EmbeddedAgentRunResult, CompactionAccountingTarget>();

/** Keeps the history owner's captured custody off public result and wire shapes. */
export function bindCliRunSettledWriter<T extends EmbeddedAgentRunResult>(
  result: T,
  writer: CliHistoryWriter | undefined,
): T {
  if (writer) {
    settledWriters.set(
      result,
      Object.freeze({
        ...writer.target,
        lifecycleRevision: writer.lifecycleRevision,
        activeWriterRunId: writer.expectedWriterRunId,
      }),
    );
  }
  return result;
}

export function readCliRunSettledWriter(
  result: EmbeddedAgentRunResult,
): CompactionAccountingTarget | undefined {
  return settledWriters.get(result);
}

/** Result decoration retains the same captured writer without discovering a new owner. */
export function copyCliRunSettledWriter<T extends EmbeddedAgentRunResult>(
  source: EmbeddedAgentRunResult,
  result: T,
): T {
  const writer = settledWriters.get(source);
  if (writer) {
    settledWriters.set(result, writer);
  }
  return result;
}
