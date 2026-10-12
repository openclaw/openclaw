import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { loadExecApprovals, resolveExecApprovalsFromFile } from "../infra/exec-approvals.js";
import { listActiveProcessSessionReferences } from "./bash-process-references.js";
import { resolveProcessToolScopeKey } from "./bash-process-scope.js";
import type { RuntimeContextFragment } from "./internal-runtime-context.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

export type ExecutionHostRuntimeFactsParams = {
  capabilityToolNames: ReadonlySet<string>;
  sessionKey?: string;
  sessionId?: string;
  agentId: string;
  /** Retained carriers need explicit empty snapshots to supersede older facts. */
  includeEmptySnapshots?: boolean;
};

function buildApprovedExecutablesRuntimeContext(
  agentId: string,
  includeEmptySnapshots: boolean,
): string | undefined {
  const header = "## Approved executables";
  try {
    const { allowlist } = resolveExecApprovalsFromFile({ file: loadExecApprovals(), agentId });
    const hints = allowlist
      .flatMap((entry) => {
        const pattern = entry.pattern.trim();
        if (pattern.startsWith("=command:") || !/[\\/~]/.test(pattern)) {
          return [];
        }
        // Keep absolute approval tokens exact; a basename can resolve to another binary.
        const name = path.win32.isAbsolute(pattern)
          ? pattern
          : path.win32.basename(pattern).replace(/\.exe$/i, "");
        // Omit hints that cannot be displayed faithfully within the prompt budget.
        if (!name || name.length > 256 || sanitizeForPromptLiteral(name) !== name) {
          return [];
        }
        return [`  ${name} ${entry.argPattern ? "(restricted args)" : "(any arguments)"}`];
      })
      .toSorted()
      .slice(0, 10);
    if (!hints.length && !includeEmptySnapshots) {
      return undefined;
    }
    return [
      header,
      hints.length
        ? "Pre-approved executables (exact arguments are enforced at runtime; no approval prompt needed when args match):"
        : "none",
      ...hints,
    ].join("\n");
  } catch {
    // Hints are advisory; approval loading must not block prompt preparation.
    return `${header}\nunavailable`;
  }
}

export function buildExecutionHostRuntimeFacts(
  params: ExecutionHostRuntimeFactsParams,
): RuntimeContextFragment[] {
  const sections: string[] = [];
  const includeEmptySnapshots = params.includeEmptySnapshots === true;
  if (process.platform === "win32" && params.capabilityToolNames.has("exec")) {
    const approved = buildApprovedExecutablesRuntimeContext(params.agentId, includeEmptySnapshots);
    if (approved) {
      sections.push(approved);
    }
  }
  if (params.capabilityToolNames.has("process")) {
    const sessions = listActiveProcessSessionReferences({
      scopeKey: resolveProcessToolScopeKey(params),
    })
      .toSorted((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
      .map((session) => {
        const pid = typeof session.pid === "number" ? ` pid=${session.pid}` : "";
        const cwd = session.cwd
          ? ` cwd=${truncateUtf16Safe(sanitizeForPromptLiteral(session.cwd), 256)}`
          : "";
        return `- ${session.sessionId} ${session.status}${pid}${cwd} :: ${sanitizeForPromptLiteral(session.name)}`;
      });
    if (sessions.length || includeEmptySnapshots) {
      sections.push(`Active exec sessions:\n${sessions.join("\n") || "none"}`);
    }
  }
  return sections.map((text) => ({ kind: "conversation-data", text }));
}
