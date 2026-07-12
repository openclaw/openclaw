// Performance breakdown aggregates per-run events into analysis-friendly groups.
import type {
  PerformanceBreakdownEntry,
  PerformanceEvent,
  RunPerformanceBreakdown,
  RunPerformanceTrace,
} from "./types.js";

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function bumpEntry(
  map: Map<string, PerformanceBreakdownEntry>,
  key: string,
  label: string,
  durationMs: number,
  outcome?: string,
): void {
  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    existing.totalMs = roundMs(existing.totalMs + durationMs);
    existing.avgMs = roundMs(existing.totalMs / existing.count);
    existing.maxMs = roundMs(Math.max(existing.maxMs, durationMs));
    if (outcome === "error") {
      existing.errorCount = (existing.errorCount ?? 0) + 1;
    }
    return;
  }
  map.set(key, {
    key,
    label,
    count: 1,
    totalMs: roundMs(durationMs),
    avgMs: roundMs(durationMs),
    maxMs: roundMs(durationMs),
    ...(outcome === "error" ? { errorCount: 1 } : {}),
  });
}

function sortedEntries(map: Map<string, PerformanceBreakdownEntry>): PerformanceBreakdownEntry[] {
  return [...map.values()].sort((left, right) => {
    if (right.totalMs !== left.totalMs) {
      return right.totalMs - left.totalMs;
    }
    return left.label.localeCompare(right.label);
  });
}

function hookHandlerKey(event: PerformanceEvent): string {
  if (event.handlerRef?.trim()) {
    return event.handlerRef.trim();
  }
  const pluginId = event.extensionId?.trim() || "unknown";
  const hookName = event.hookName?.trim() || "hook";
  return `hook:${pluginId}:${hookName}`;
}

function hookHandlerLabel(event: PerformanceEvent): string {
  const pluginId = event.extensionId?.trim() || "unknown";
  const hookName = event.hookName?.trim() || "hook";
  if (event.handlerName?.trim()) {
    return `${pluginId} → ${hookName} → ${event.handlerName.trim()}`;
  }
  if (event.handlerRef?.trim()) {
    return event.handlerRef.trim();
  }
  if (event.handlerSource?.trim()) {
    return `${pluginId} → ${hookName} (#${event.handlerSource.trim()})`;
  }
  return `${pluginId} → ${hookName}`;
}

function toolKey(event: PerformanceEvent): string {
  const toolName = event.toolName?.trim() || event.mcpToolName?.trim();
  if (event.handlerRef?.trim()) {
    return event.handlerRef.trim();
  }
  const extensionId = event.extensionId?.trim();
  if (extensionId && toolName) {
    return `tool:${extensionId}:${toolName}`;
  }
  return `tool:${toolName || "unknown"}`;
}

function toolLabel(event: PerformanceEvent): string {
  const extensionId = event.extensionId?.trim();
  const toolName = event.toolName?.trim() || event.mcpToolName?.trim();
  if (extensionId && toolName) {
    return `${extensionId} → ${toolName}`;
  }
  if (toolName) {
    return toolName;
  }
  return event.handlerRef?.trim() || "tool";
}

function llmKey(event: PerformanceEvent): string {
  return (
    event.handlerRef?.trim() ||
    `llm:${event.provider?.trim() || "unknown"}/${event.model?.trim() || "unknown"}`
  );
}

function llmLabel(event: PerformanceEvent): string {
  if (event.handlerRef?.trim()) {
    return event.handlerRef.trim();
  }
  const provider = event.provider?.trim() || "unknown";
  const model = event.model?.trim() || "unknown";
  return `${provider}/${model}`;
}

function extensionKey(event: PerformanceEvent): string | undefined {
  const extensionId = event.extensionId?.trim();
  if (!extensionId) {
    return undefined;
  }
  return extensionId;
}

function extensionLabel(extensionId: string, event: PerformanceEvent): string {
  switch (event.kind) {
    case "hook_handler":
      return `${extensionId} (hooks)`;
    case "tool":
      return `${extensionId} (tools)`;
    case "llm":
      return `${extensionId} (llm)`;
    case "harness":
      return `${extensionId} (harness)`;
    default:
      return extensionId;
  }
}

export function buildRunPerformanceBreakdown(trace: RunPerformanceTrace): RunPerformanceBreakdown {
  const phases = new Map<string, PerformanceBreakdownEntry>();
  const hookHandlers = new Map<string, PerformanceBreakdownEntry>();
  const tools = new Map<string, PerformanceBreakdownEntry>();
  const llmCalls = new Map<string, PerformanceBreakdownEntry>();
  const byExtension = new Map<string, PerformanceBreakdownEntry>();

  let phaseMs = 0;
  let hookHandlerMs = 0;
  let toolMs = 0;
  let llmMs = 0;
  let harnessMs = 0;

  for (const event of trace.events) {
    const durationMs = event.durationMs ?? 0;
    switch (event.kind) {
      case "phase": {
        phaseMs = roundMs(phaseMs + durationMs);
        const key = event.phaseName?.trim() || "phase";
        bumpEntry(phases, key, key, durationMs);
        break;
      }
      case "hook_handler": {
        hookHandlerMs = roundMs(hookHandlerMs + durationMs);
        bumpEntry(
          hookHandlers,
          hookHandlerKey(event),
          hookHandlerLabel(event),
          durationMs,
          event.outcome,
        );
        break;
      }
      case "tool": {
        toolMs = roundMs(toolMs + durationMs);
        bumpEntry(tools, toolKey(event), toolLabel(event), durationMs, event.outcome);
        break;
      }
      case "llm": {
        llmMs = roundMs(llmMs + durationMs);
        bumpEntry(llmCalls, llmKey(event), llmLabel(event), durationMs, event.outcome);
        break;
      }
      case "harness": {
        harnessMs = roundMs(harnessMs + durationMs);
        break;
      }
      default:
        break;
    }

    const extensionId = extensionKey(event);
    if (extensionId && durationMs > 0 && event.kind !== "phase" && event.kind !== "run") {
      bumpEntry(
        byExtension,
        `${extensionId}:${event.kind}`,
        extensionLabel(extensionId, event),
        durationMs,
        event.outcome,
      );
    }
  }

  const measuredMs = roundMs(phaseMs + hookHandlerMs + toolMs + llmMs + harnessMs);
  const totalDurationMs = trace.totalDurationMs;
  const unaccountedMs =
    totalDurationMs !== undefined ? roundMs(Math.max(0, totalDurationMs - measuredMs)) : undefined;

  return {
    phases: sortedEntries(phases),
    hookHandlers: sortedEntries(hookHandlers),
    tools: sortedEntries(tools),
    llmCalls: sortedEntries(llmCalls),
    byExtension: sortedEntries(byExtension),
    categoryTotals: {
      phaseMs,
      hookHandlerMs,
      toolMs,
      llmMs,
      harnessMs,
      measuredMs,
      ...(totalDurationMs !== undefined ? { totalDurationMs } : {}),
      ...(unaccountedMs !== undefined ? { unaccountedMs } : {}),
    },
  };
}

export const testApi = {
  roundMs,
};

export { testApi as __test__ };
