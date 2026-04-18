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

/**
 * PR-14 review fix (Codex P2 #3105434459): parse a Telegram threadId
 * safely. Accepts: a finite positive number, a string of digits, or a
 * scoped string of form `"<chatId>:<threadId>"` where the suffix
 * after the colon is digits. Returns `undefined` for anything else
 * (incl. NaN, negative, or unparseable values) — caller treats
 * undefined as "no thread routing" rather than passing NaN to the
 * Telegram API (which would silently lose the topic scope).
 */
function parseTelegramThreadId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    // Try direct parse first (most common: pure digits).
    const direct = Number.parseInt(trimmed, 10);
    if (Number.isFinite(direct) && direct > 0 && String(direct) === trimmed) {
      return direct;
    }
    // Scoped form: take the suffix after the LAST colon.
    const colonIdx = trimmed.lastIndexOf(":");
    if (colonIdx >= 0 && colonIdx < trimmed.length - 1) {
      const suffix = trimmed.slice(colonIdx + 1);
      const parsed = Number.parseInt(suffix, 10);
      if (Number.isFinite(parsed) && parsed > 0 && String(parsed) === suffix) {
        return parsed;
      }
    }
  }
  return undefined;
}

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

    // 4. Telegram document upload (via the SDK facade — the canonical
    // path for core code calling bundled-plugin runtime helpers per
    // src/plugin-sdk/CLAUDE.md boundary rules).
    const { sendDocumentTelegram } = await import("../../plugin-sdk/telegram.js");
    const caption = buildPlanAttachmentCaption(input.details.title, input.details.summary);
    // PR-14 review fix (Codex P2 #3105434459): parse the threadId
    // safely. Telegram delivery contexts can carry scoped thread ids
    // like `"<chatId>:<threadId>"` for DM-topic flows, where a raw
    // `Number(...)` coerces to NaN. Use a guarded parse: numeric or
    // numeric-suffix-after-colon only; bail on anything else (no
    // thread routing rather than NaN).
    const messageThreadId = parseTelegramThreadId(dctx.threadId);
    await sendDocumentTelegram(dctx.to, absPath, {
      caption,
      parseMode: "HTML",
      ...(messageThreadId !== undefined ? { messageThreadId } : {}),
      ...(dctx.accountId ? { accountId: dctx.accountId } : {}),
    });
    log?.info?.(`plan-bridge: telegram attachment sent (${filename} → chat ${dctx.to})`);
  } catch (err) {
    log?.warn?.(
      `plan-bridge attachment failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
