import type { SessionEntry } from "../../config/sessions/types.js";
/**
 * PR-14: plan-mode → channel attachment bridge.
 *
 * When the runtime emits a plan-mode approval, this orchestrator:
 *   1. Renders the full archetype as a markdown document.
 *   2. Persists the markdown to ~/.openclaw/agents/<agentId>/plans/
 *      so operators have a durable audit trail across all sessions.
 *   3. If the originating session is from a channel that supports
 *      file attachments (Telegram today; Discord/Slack/etc. later),
 *      uploads the markdown as a document attachment to the chat
 *      with a short caption containing the universal /plan
 *      resolution slash commands.
 *
 * Resolution stays text-based via PR-11's universal /plan slash
 * commands. This bridge is read-only (visibility), no approval-id
 * translator required — sidesteps the dual-id problem documented in
 * the PR-13 deferral notes.
 *
 * Always best-effort: failures log at warn and never propagate.
 */
import type { AgentApprovalPlanStep } from "../../infra/agent-events.js";
import { renderFullPlanArchetypeMarkdown } from "../plan-render.js";
import { persistPlanArchetypeMarkdown } from "./plan-archetype-persist.js";

export interface DispatchPlanArchetypeAttachmentInput {
  sessionKey: string;
  agentId: string;
  /**
   * The same `details` object passed to the approval emit — carries
   * the full archetype (title, summary, plan steps, analysis,
   * assumptions, risks, verification, references).
   */
  details: {
    title?: string;
    summary?: string;
    analysis?: string;
    plan: AgentApprovalPlanStep[];
    assumptions?: string[];
    risks?: Array<{ risk: string; mitigation: string }>;
    verification?: string[];
    references?: string[];
  };
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  /** Injectable now() for tests. */
  nowMs?: number;
  /**
   * Override the persistence base directory (tests use a temp dir).
   * Production never sets this — defaults to `~/.openclaw/agents` via
   * persistPlanArchetypeMarkdown.
   */
  persistBaseDir?: string;
}

/**
 * Build the short caption attached to the markdown document. Includes
 * the plan title (if any) and the universal /plan resolution
 * commands so the user knows how to act on the file from their
 * channel. Truncated to ≤1000 chars by sendDocumentTelegram (Telegram
 * caption limit is 1024).
 */
export function buildPlanAttachmentCaption(
  title: string | undefined,
  summary: string | undefined,
): string {
  const safeTitle = (title ?? "").trim() || "Plan";
  const escTitle = escapeHtml(safeTitle);
  const safeSummary = (summary ?? "").trim();
  const summaryLine = safeSummary ? `\n${escapeHtml(safeSummary)}` : "";
  return [
    `<b>${escTitle}</b> — plan submitted for approval. See attached.`,
    summaryLine,
    "",
    "Resolve with: <code>/plan accept</code> | <code>/plan accept edits</code> | <code>/plan revise &lt;feedback&gt;</code>",
  ]
    .filter(Boolean)
    .join("\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Consolidation-pass note: `parseTelegramThreadId` was the PR-14
// helper for the now-deferred Telegram document-attachment delivery
// (see plan-archetype-bridge.ts:200ish). The helper is kept here in
// commented-out form so PR-14's re-wire follow-up can resurrect it
// without rewriting the parsing logic from scratch:
//
// function parseTelegramThreadId(raw: unknown): number | undefined {
//   if (raw === undefined || raw === null) return undefined;
//   if (typeof raw === "number") {
//     return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
//   }
//   if (typeof raw === "string") {
//     const trimmed = raw.trim();
//     if (trimmed.length === 0) return undefined;
//     const direct = Number.parseInt(trimmed, 10);
//     if (Number.isFinite(direct) && direct > 0 && String(direct) === trimmed) return direct;
//     const colonIdx = trimmed.lastIndexOf(":");
//     if (colonIdx >= 0 && colonIdx < trimmed.length - 1) {
//       const suffix = trimmed.slice(colonIdx + 1);
//       const parsed = Number.parseInt(suffix, 10);
//       if (Number.isFinite(parsed) && parsed > 0 && String(parsed) === suffix) return parsed;
//     }
//   }
//   return undefined;
// }

/**
 * Read-only session entry lookup. Mirrors the
 * `loadSessionStoreRuntime` + `updateSessionStoreEntry` pattern used
 * elsewhere in the runtime, but as a non-mutating read.
 */
async function loadSessionEntryReadOnly(sessionKey: string): Promise<SessionEntry | undefined> {
  try {
    const [
      { loadConfig },
      { resolveStorePath },
      { parseAgentSessionKey },
      { readSessionStoreReadOnly },
    ] = await Promise.all([
      import("../../config/config.js"),
      import("../../config/sessions/paths.js"),
      import("../../routing/session-key.js"),
      import("../../config/sessions/store-read.js"),
    ]);
    const cfg = loadConfig();
    const parsed = parseAgentSessionKey(sessionKey);
    const storePath = resolveStorePath(
      cfg.session?.store,
      parsed?.agentId ? { agentId: parsed.agentId } : {},
    );
    const store = readSessionStoreReadOnly(storePath);
    return store[sessionKey];
  } catch {
    return undefined;
  }
}

export async function dispatchPlanArchetypeAttachment(
  input: DispatchPlanArchetypeAttachmentInput,
): Promise<void> {
  const log = input.log;
  try {
    // 1. Render markdown.
    const markdown = renderFullPlanArchetypeMarkdown({
      title: input.details.title ?? "Plan",
      summary: input.details.summary,
      analysis: input.details.analysis,
      plan: input.details.plan as Parameters<typeof renderFullPlanArchetypeMarkdown>[0]["plan"],
      assumptions: input.details.assumptions,
      risks: input.details.risks,
      verification: input.details.verification,
      references: input.details.references,
      generatedAt: input.nowMs ? new Date(input.nowMs) : undefined,
    });

    // 2. Persist (always — durable audit artifact).
    const { absPath, filename } = await persistPlanArchetypeMarkdown({
      agentId: input.agentId,
      title: input.details.title,
      markdown,
      now: input.nowMs ? new Date(input.nowMs) : undefined,
      ...(input.persistBaseDir ? { baseDir: input.persistBaseDir } : {}),
    });
    log?.info?.(`plan-bridge: persisted ${filename}`);

    // 3. Channel-aware delivery. Read SessionEntry → deliveryContext.
    const entry = await loadSessionEntryReadOnly(input.sessionKey);
    const { deliveryContextFromSession } = await import("../../utils/delivery-context.shared.js");
    const dctx = entry ? deliveryContextFromSession(entry) : undefined;
    if (!dctx?.channel || dctx.channel !== "telegram" || !dctx.to) {
      log?.debug?.(
        `plan-bridge: no telegram delivery (channel=${dctx?.channel ?? "none"}, to=${dctx?.to ?? "none"})`,
      );
      return;
    }

    // 4. Telegram document upload — DEFERRED.
    // Consolidation pass note: `src/plugin-sdk/telegram.ts` was
    // removed in upstream's plugin-sdk restructure. The PR-14 PR
    // (Telegram plan-mode visibility via markdown attachment) needs
    // its delivery surface re-wired to the new SDK location before
    // this branch can call into it. Until then, the markdown plan
    // file is still persisted to disk (steps 1-3 above) but not
    // pushed as a Telegram attachment. Tracked as a PR-14 follow-up.
    const caption = buildPlanAttachmentCaption(input.details.title, input.details.summary);
    void caption;
    void absPath;
    log?.info?.(
      `plan-bridge: telegram attachment skipped (PR-14 awaiting re-wire to new plugin-sdk location); plan markdown persisted at ${absPath}`,
    );
  } catch (err) {
    log?.warn?.(
      `plan-bridge attachment failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
