/**
 * Context Restore Plugin
 *
 * Solves a real problem: long-running OpenClaw agents suffer identity and
 * context drift after LCM compaction. When the conversation history is
 * compacted, the agent loses awareness of its own configuration, guidelines,
 * and recent memory — and may behave inconsistently until it re-reads them.
 *
 * Two-layer approach:
 *
 * 1. STATIC SYSTEM CONTEXT (every turn, via appendSystemContext):
 *    Appends a configurable anchor text to the system prompt on every turn.
 *    When using Anthropic models, this block is cache-eligible — zero marginal
 *    token cost after the first turn. Use it for short, stable reminders that
 *    should survive any compaction.
 *
 * 2. POST-COMPACTION RESTORE (via after_compaction hook):
 *    After compaction fires, enqueues a system event telling the agent to
 *    re-read a configurable list of files (e.g. SOUL.md, AGENTS.md, SECURITY.md,
 *    today's memory). The agent silently restores its context before the next
 *    user turn.
 *
 * Configuration:
 *   anchorText    — text appended to the system prompt every turn.
 *                   Default: a short reminder to check config files after compaction.
 *   restoreFiles  — list of file paths (relative to agent workspace) to re-read
 *                   after compaction. Default: ["AGENTS.md"].
 *   sessionPrefix — only apply to sessions whose key starts with this string.
 *                   Default: "" (all sessions).
 */
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { contextRestoreConfigSchema, type ContextRestoreConfig } from "./config.js";

export default definePluginEntry({
  id: "context-restore",
  name: "Context Restore",
  description:
    "Two-layer context protection: static system-prompt anchor every turn, plus automatic file restore after LCM compaction.",
  configSchema: contextRestoreConfigSchema,
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as ContextRestoreConfig;

    const anchorText =
      cfg.anchorText ??
      "CONTEXT ANCHOR: If your context was recently compacted, re-read your core config files before responding.";

    const restoreFiles: string[] = cfg.restoreFiles ?? ["AGENTS.md"];

    const sessionPrefix: string = cfg.sessionPrefix ?? "";

    // ── 1. Static system context anchor (every turn) ─────────────────────────
    api.on(
      "before_prompt_build",
      async (_event: unknown, ctx: Record<string, unknown>) => {
        const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
        if (sessionPrefix && !sessionKey.startsWith(sessionPrefix)) {
          return {};
        }
        return { appendSystemContext: anchorText };
      },
      { priority: 5 },
    );

    // ── 2. Post-compaction file restore ──────────────────────────────────────
    //
    // Hook name: "after_compaction" (typed plugin hook)
    // Event shape (PluginHookAfterCompactionEvent):
    //   { messageCount, tokenCount?, compactedCount, sessionFile? }
    // Context shape (PluginHookAgentContext):
    //   { agentId?, sessionKey?, sessionId?, workspaceDir? }
    api.on(
      "after_compaction",
      async (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
        const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
        if (!sessionKey) {
          return;
        }
        if (sessionPrefix && !sessionKey.startsWith(sessionPrefix)) {
          return;
        }

        const rawCount = event?.compactedCount;
        const compactedCount =
          typeof rawCount === "number" || typeof rawCount === "string" ? String(rawCount) : "?";

        if (restoreFiles.length === 0) {
          return;
        }

        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; // YYYY-MM-DD local timezone
        const resolvedFiles = restoreFiles.map((f) => f.replace(/YYYY-MM-DD/g, today));
        const fileList = resolvedFiles.map((f, i) => `${i + 1}. Read ${f}`).join("\n");

        const prompt = [
          `[CONTEXT RESTORE] Context compacted (${compactedCount} messages compacted). Re-read the following files now to restore full awareness:`,
          fileList,
          "Re-read these files silently and continue normally.",
        ].join("\n");

        api.runtime?.system?.enqueueSystemEvent?.(prompt, {
          sessionKey,
          contextKey: `context-restore-${Date.now()}`,
        });
      },
      { priority: 10 },
    );
  },
});
