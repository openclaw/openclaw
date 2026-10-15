import type { MemoryCliSearchOutcome } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  defaultRuntime,
  formatCliJsonFailure,
  shortenHomePath,
  theme,
} from "openclaw/plugin-sdk/memory-core-host-runtime-cli";

export function renderMemorySearch(result: MemoryCliSearchOutcome, json?: boolean): void {
  if ("status" in result) {
    if (result.status === "disabled") {
      defaultRuntime.log("Memory search disabled.");
      if (json) {
        defaultRuntime.writeJson(result);
      }
    } else {
      const message = `memory search failed (${result.agentId}): ${result.error}`;
      defaultRuntime.error(message);
      process.exitCode = 1;
      if (json) {
        defaultRuntime.writeJson({ ...formatCliJsonFailure(message), agentId: result.agentId });
      }
    }
    return;
  }
  if (json) {
    defaultRuntime.writeJson(result);
    return;
  }
  if (result.warning) {
    defaultRuntime.error([result.warning, result.action].filter(Boolean).join(" "));
  }
  if (result.results.length === 0) {
    defaultRuntime.log("No matches.");
    return;
  }
  const lines: string[] = [];
  for (const hit of result.results) {
    lines.push(
      `${theme.success(hit.score.toFixed(3))} ${theme.accent(`${shortenHomePath(hit.path)}:${hit.startLine}-${hit.endLine}`)}`,
      theme.muted(hit.snippet),
      "",
    );
  }
  defaultRuntime.log(lines.join("\n").trim());
}
