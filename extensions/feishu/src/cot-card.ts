/**
 * Feishu native COT (Chain-of-Thought) card model.
 *
 * Builds Card Kit 2.0 body elements that mirror the AnyGen Agent "new Lark COT"
 * experience:
 *  - the final answer stays at the top, clearly separated from the process;
 *  - reasoning ("thinking") is rendered inside a native `collapsible_panel`
 *    that is collapsed by default;
 *  - consecutive tool calls are aggregated into a single `collapsible_panel`
 *    with one row per call and a unified running / success / failed status;
 *
 * The model is a pure data structure so it can be unit-tested and reused by
 * both the streaming session (full-card updates) and any non-streaming path.
 */

/** Unified lifecycle status shared by tool rows and the whole card header. */
export type CotStatus = "running" | "success" | "failed";

/** Status icons kept consistent across running / success / failed states. */
const STATUS_ICON: Record<CotStatus, string> = {
  running: "⏳",
  success: "✅",
  failed: "❌",
};

/** Feishu header color template per unified status. */
const STATUS_TEMPLATE: Record<CotStatus, string> = {
  running: "blue",
  success: "green",
  failed: "red",
};

/** Max characters for a derived thinking title before falling back to a label. */
const THINKING_TITLE_MAX = 80;
/** Max characters kept for a single tool-row detail line. */
const TOOL_DETAIL_MAX = 120;

/** Localized labels. Chinese first (primary product locale), English fallback. */
export type CotLocale = "zh" | "en";

const LABELS: Record<CotLocale, { thinking: string; tools: string; thinkingFallback: string }> = {
  zh: { thinking: "思考过程", tools: "工具调用", thinkingFallback: "思考过程" },
  en: { thinking: "Thinking", tools: "Tool Calls", thinkingFallback: "Thought Process" },
};

export type CotToolRow = {
  /** Stable id used to coalesce start → update → terminal into one row. */
  id: string;
  /** Human-facing tool label (already resolved via tool-display). */
  label: string;
  /** Optional one-line detail (args / result preview). */
  detail?: string;
  status: CotStatus;
};

export type CotCardState = {
  /** Final answer / visible assistant output. Empty while still running. */
  answer: string;
  /** Accumulated reasoning text. Empty when there is no thinking. */
  thinking: string;
  /** Tool rows in first-seen order. */
  tools: CotToolRow[];
  /** Whether the turn is still running (drives placeholder + header state). */
  running: boolean;
  /** Whether the turn ended in an error. */
  errored: boolean;
  locale: CotLocale;
};

export function createCotCardState(locale: CotLocale = "zh"): CotCardState {
  return { answer: "", thinking: "", tools: [], running: true, errored: false, locale };
}

/**
 * Derive a short thinking-title from the reasoning text, matching the AnyGen
 * frontend heuristic: strip lightweight markdown, take the first paragraph,
 * and use it as the title when it fits; otherwise use a stable fallback label.
 */
export function deriveThinkingTitle(thinking: string, locale: CotLocale = "zh"): string {
  const fallback = LABELS[locale].thinkingFallback;
  if (!thinking) {
    return fallback;
  }
  const firstParagraph = thinking.split(/\n\s*\n/)[0] ?? "";
  const stripped = stripMarkdownInline(firstParagraph).replace(/\s+/g, " ").trim();
  if (!stripped) {
    return fallback;
  }
  return stripped.length <= THINKING_TITLE_MAX ? stripped : fallback;
}

/** Remove lightweight inline markdown so titles read as plain text. */
function stripMarkdownInline(input: string): string {
  return input
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1") // italics
    .replace(/_([^_]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images -> alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links -> label
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

/** Escape characters that would break Feishu markdown table / row layout. */
function sanitizeRow(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/** Resolve the whole-card status from tool rows + running/errored flags. */
export function resolveCardStatus(state: CotCardState): CotStatus {
  if (state.errored) {
    return "failed";
  }
  if (state.running) {
    return "running";
  }
  if (state.tools.some((tool) => tool.status === "failed")) {
    return "failed";
  }
  return "success";
}

/** Build the collapsible thinking panel element (collapsed by default). */
function buildThinkingPanel(state: CotCardState): Record<string, unknown> | null {
  const thinking = state.thinking.trim();
  if (!thinking) {
    return null;
  }
  const title = deriveThinkingTitle(state.thinking, state.locale);
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: { tag: "markdown", content: `💭 **${title}**` },
      vertical_align: "center",
    },
    element_id: "cot_thinking",
    elements: [{ tag: "markdown", content: blockquote(thinking) }],
  };
}

/** Prefix each line with a blockquote marker for a muted "reasoning" look. */
function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Build the aggregated tool-call panel (collapsed by default). */
function buildToolPanel(state: CotCardState): Record<string, unknown> | null {
  if (state.tools.length === 0) {
    return null;
  }
  const label = LABELS[state.locale].tools;
  const doneCount = state.tools.filter((tool) => tool.status !== "running").length;
  const anyRunning = state.tools.some((tool) => tool.status === "running");
  const anyFailed = state.tools.some((tool) => tool.status === "failed");
  const headerIcon = anyRunning ? STATUS_ICON.running : anyFailed ? STATUS_ICON.failed : STATUS_ICON.success;
  const rows = state.tools.map((tool) => renderToolRow(tool)).join("\n");
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: {
        tag: "markdown",
        content: `${headerIcon} **${label}** (${doneCount}/${state.tools.length})`,
      },
      vertical_align: "center",
    },
    element_id: "cot_tools",
    elements: [{ tag: "markdown", content: rows }],
  };
}

/** Render one tool row: status icon + label + optional detail. */
function renderToolRow(tool: CotToolRow): string {
  const icon = STATUS_ICON[tool.status];
  const label = sanitizeRow(tool.label) || "tool";
  const detail = tool.detail ? sanitizeRow(truncate(tool.detail, TOOL_DETAIL_MAX)) : "";
  return detail ? `${icon} ${label} — ${detail}` : `${icon} ${label}`;
}

/**
 * Build the full Card Kit 2.0 body elements for the current COT state.
 *
 * Layout (top → bottom):
 *   [final answer | running placeholder]
 *   [--- divider, only when both answer and process exist ---]
 *   [thinking collapsible_panel]
 *   [tool collapsible_panel]
 *   [--- divider + note, when note provided ---]
 */
export function buildCotCardElements(
  state: CotCardState,
  options?: { note?: string; runningPlaceholder?: string },
): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  const answer = state.answer.trim();
  const placeholder = options?.runningPlaceholder ?? "⏳ Thinking...";

  // Final answer stays at the top and is always the `content` element so the
  // streaming per-element update path keeps working.
  elements.push({
    tag: "markdown",
    content: answer || placeholder,
    element_id: "content",
  });

  const thinkingPanel = buildThinkingPanel(state);
  const toolPanel = buildToolPanel(state);
  const hasProcess = Boolean(thinkingPanel || toolPanel);

  // Divider only when both a real answer and process detail are present, to
  // keep the "final result vs intermediate process" layering explicit.
  if (answer && hasProcess) {
    elements.push({ tag: "hr" });
  }
  if (thinkingPanel) {
    elements.push(thinkingPanel);
  }
  if (toolPanel) {
    elements.push(toolPanel);
  }

  if (options?.note) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "markdown",
      content: `<font color='grey'>${options.note}</font>`,
      element_id: "note",
    });
  }
  return elements;
}

/** Resolve the header color template for the current unified status. */
export function resolveCotHeaderTemplate(state: CotCardState): string {
  return STATUS_TEMPLATE[resolveCardStatus(state)];
}

/** Whether the state carries any COT process detail (thinking or tools). */
export function hasCotProcess(state: CotCardState): boolean {
  return Boolean(state.thinking.trim()) || state.tools.length > 0;
}
