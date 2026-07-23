import { describe, expect, it } from "vitest";
import {
  buildCotCardElements,
  createCotCardState,
  deriveThinkingTitle,
  hasCotProcess,
  resolveCardStatus,
  resolveCotHeaderTemplate,
  type CotCardState,
} from "./cot-card.js";

type El = Record<string, unknown>;

function findById(elements: El[], id: string): El | undefined {
  return elements.find((el) => el.element_id === id);
}

function findPanels(elements: El[]): El[] {
  return elements.filter((el) => el.tag === "collapsible_panel");
}

function panelMarkdown(panel: El): string {
  const elements = (panel.elements as El[]) ?? [];
  return String((elements[0]?.content as string) ?? "");
}

function headerTitle(panel: El): string {
  const header = panel.header as { title?: { content?: string } } | undefined;
  return String(header?.title?.content ?? "");
}

describe("deriveThinkingTitle", () => {
  it("uses the first paragraph when short, stripping markdown", () => {
    expect(deriveThinkingTitle("**分析用户需求**\n\n接下来...", "zh")).toBe("分析用户需求");
    expect(deriveThinkingTitle("Let me `check` the [docs](http://x)", "en")).toBe(
      "Let me check the docs",
    );
  });

  it("falls back to a stable label when the first paragraph is too long", () => {
    const long = "关于这个问题".repeat(30);
    expect(deriveThinkingTitle(long, "zh")).toBe("思考过程");
    expect(deriveThinkingTitle("x".repeat(200), "en")).toBe("Thought Process");
  });

  it("falls back when thinking is empty", () => {
    expect(deriveThinkingTitle("", "zh")).toBe("思考过程");
    expect(deriveThinkingTitle("   ", "en")).toBe("Thought Process");
  });
});

describe("resolveCardStatus", () => {
  it("reports running while the turn is active", () => {
    const state = createCotCardState();
    expect(resolveCardStatus(state)).toBe("running");
    expect(resolveCotHeaderTemplate(state)).toBe("blue");
  });

  it("reports success when finished cleanly", () => {
    const state: CotCardState = {
      ...createCotCardState(),
      running: false,
      tools: [{ id: "a", label: "Read", status: "success" }],
    };
    expect(resolveCardStatus(state)).toBe("success");
    expect(resolveCotHeaderTemplate(state)).toBe("green");
  });

  it("reports failed when errored or a tool failed", () => {
    const errored: CotCardState = { ...createCotCardState(), running: false, errored: true };
    expect(resolveCardStatus(errored)).toBe("failed");
    expect(resolveCotHeaderTemplate(errored)).toBe("red");

    const toolFailed: CotCardState = {
      ...createCotCardState(),
      running: false,
      tools: [{ id: "a", label: "Bash", status: "failed" }],
    };
    expect(resolveCardStatus(toolFailed)).toBe("failed");
  });
});

describe("buildCotCardElements", () => {
  it("shows a running placeholder and no divider before any answer", () => {
    const elements = buildCotCardElements(createCotCardState(), {
      runningPlaceholder: "⏳ 思考中...",
    });
    const content = findById(elements, "content");
    expect(content?.content).toBe("⏳ 思考中...");
    expect(elements.some((el) => el.tag === "hr")).toBe(false);
  });

  it("renders a collapsed thinking panel with a derived title", () => {
    const state: CotCardState = {
      ...createCotCardState("zh"),
      thinking: "先理解需求\n\n然后拆解任务",
    };
    const elements = buildCotCardElements(state);
    const panel = findById(elements, "cot_thinking");
    expect(panel).toBeDefined();
    expect(panel?.tag).toBe("collapsible_panel");
    expect(panel?.expanded).toBe(false); // default collapsed
    expect(headerTitle(panel!)).toContain("先理解需求");
    // reasoning body is blockquoted
    expect(panelMarkdown(panel!)).toContain("> 先理解需求");
  });

  it("aggregates consecutive tool calls into one panel with unified status", () => {
    const state: CotCardState = {
      ...createCotCardState("zh"),
      running: false,
      answer: "完成。",
      tools: [
        { id: "1", label: "Read", detail: "config.json", status: "success" },
        { id: "2", label: "Bash", detail: "npm test", status: "failed" },
        { id: "3", label: "Edit", status: "success" },
      ],
    };
    const elements = buildCotCardElements(state);
    const panels = findPanels(elements);
    expect(panels).toHaveLength(1); // single aggregated tool panel
    const toolPanel = findById(elements, "cot_tools")!;
    expect(toolPanel.expanded).toBe(false);
    // header shows completed count and failure icon
    expect(headerTitle(toolPanel)).toContain("工具调用");
    expect(headerTitle(toolPanel)).toContain("(3/3)");
    expect(headerTitle(toolPanel)).toContain("❌");
    const body = panelMarkdown(toolPanel);
    expect(body).toContain("✅ Read — config.json");
    expect(body).toContain("❌ Bash — npm test");
    expect(body).toContain("✅ Edit");
  });

  it("running tool aggregate uses the running icon and partial count", () => {
    const state: CotCardState = {
      ...createCotCardState("en"),
      tools: [
        { id: "1", label: "Read", status: "success" },
        { id: "2", label: "Bash", status: "running" },
      ],
    };
    const toolPanel = findById(buildCotCardElements(state), "cot_tools")!;
    expect(headerTitle(toolPanel)).toContain("Tool Calls");
    expect(headerTitle(toolPanel)).toContain("(1/2)");
    expect(headerTitle(toolPanel)).toContain("⏳");
  });

  it("separates the final answer from process with a divider", () => {
    const state: CotCardState = {
      ...createCotCardState(),
      running: false,
      answer: "这是最终答复。",
      thinking: "推理过程",
      tools: [{ id: "1", label: "Read", status: "success" }],
    };
    const elements = buildCotCardElements(state);
    const content = findById(elements, "content");
    expect(content?.content).toBe("这是最终答复。");
    // divider sits between the answer and the first process panel
    const answerIdx = elements.indexOf(content!);
    const hrIdx = elements.findIndex((el) => el.tag === "hr");
    const thinkingIdx = elements.findIndex((el) => el.element_id === "cot_thinking");
    expect(hrIdx).toBeGreaterThan(answerIdx);
    expect(thinkingIdx).toBeGreaterThan(hrIdx);
  });

  it("does not emit a divider when there is process but no answer yet", () => {
    const state: CotCardState = {
      ...createCotCardState(),
      thinking: "still reasoning",
    };
    const elements = buildCotCardElements(state, { runningPlaceholder: "..." });
    expect(elements.filter((el) => el.tag === "hr")).toHaveLength(0);
  });

  it("handles long answers and preserves markdown code fences", () => {
    const longAnswer = `结论如下：\n\n\`\`\`ts\nconst x = ${"a".repeat(500)};\n\`\`\``;
    const state: CotCardState = { ...createCotCardState(), running: false, answer: longAnswer };
    const content = findById(buildCotCardElements(state), "content");
    expect(content?.content).toBe(longAnswer);
  });

  it("escapes pipe characters in tool detail rows", () => {
    const state: CotCardState = {
      ...createCotCardState(),
      tools: [{ id: "1", label: "Grep", detail: "a | b | c", status: "success" }],
    };
    const body = panelMarkdown(findById(buildCotCardElements(state), "cot_tools")!);
    expect(body).toContain("a \\| b \\| c");
  });

  it("appends a grey note footer when provided", () => {
    const elements = buildCotCardElements(createCotCardState(), {
      note: "Agent: Claude | Model: opus",
    });
    const note = findById(elements, "note");
    expect(note?.content).toContain("Agent: Claude");
    expect(note?.content).toContain("color='grey'");
  });
});

describe("hasCotProcess", () => {
  it("is false with no thinking or tools", () => {
    expect(hasCotProcess(createCotCardState())).toBe(false);
  });
  it("is true when thinking exists", () => {
    expect(hasCotProcess({ ...createCotCardState(), thinking: "x" })).toBe(true);
  });
  it("is true when tools exist", () => {
    expect(
      hasCotProcess({
        ...createCotCardState(),
        tools: [{ id: "1", label: "Read", status: "running" }],
      }),
    ).toBe(true);
  });
});
