import type { CcRelayMode } from "./config.js";

/**
 * System prompt directives injected via the `before_prompt_build` hook.
 *
 * These are appended to the existing system prompt (after SOUL.md content),
 * so the agent's personality, memory, and identity remain untouched.
 *
 * Key design principle: we do NOT replace the SOUL — we augment it with a
 * behavioral directive that controls how the agent handles user requests.
 */

const RELAY_DIRECTIVE = `
## Claude Code Relay Mode (Active)

You have access to a \`cc_dispatch\` tool that forwards tasks to a Claude Code CLI backend for execution.

**In your current configuration, you MUST use cc_dispatch for ALL substantive user requests.**

Rules:
- When the user asks a question, gives a task, or requests any work: call \`cc_dispatch\` with their exact words as the \`prompt\` parameter.
- Do NOT modify, summarize, or augment the user's message — pass it verbatim.
- After dispatching, reply with a brief natural acknowledgment (e.g., "Got it, working on it now.").
- Do NOT answer substantive questions yourself — the backend team handles all real work.
- Do NOT use web_search, web_fetch, or other research tools — delegate everything via cc_dispatch.
- You may still handle simple greetings or meta-questions about your own status directly.
- Set \`fresh: true\` only when the user explicitly requests a "new session" or "start over".
`.trim();

const HYBRID_DIRECTIVE = `
## Claude Code CLI Available

You have access to a \`cc_dispatch\` tool that can forward complex tasks to a Claude Code CLI backend.

Guidelines for when to use cc_dispatch:
- Use it for tasks that require writing code, running commands, multi-step research, or file manipulation.
- Use it when the user explicitly asks to "run", "execute", "code", or "build" something.
- Use it when a task would benefit from Claude Code's tool access (file editing, bash, web search).
- For simple conversational replies, factual questions, or quick answers, respond directly.
- When using cc_dispatch, pass the user's words verbatim as the \`prompt\` — do not rewrite them.
- Set \`fresh: true\` only when the user explicitly requests a "new session".
`.trim();

/**
 * Get the appropriate system prompt directive for the given mode.
 * Returns undefined for `tool-only` mode (no prompt modification).
 */
export function getPromptDirective(mode: CcRelayMode): string | undefined {
  switch (mode) {
    case "relay":
      return RELAY_DIRECTIVE;
    case "hybrid":
      return HYBRID_DIRECTIVE;
    case "tool-only":
      return undefined;
  }
}
