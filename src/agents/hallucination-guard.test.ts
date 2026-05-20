/**
 * Regression tests for the P2.14 hallucination guard (gemma-memory
 * follow-up). The decisive verification is the TDLib end-to-end
 * suite (proposals/gemma-memory.md §12.7); these unit tests cover
 * the regex / pure-function surface only, so accidental tightening
 * or loosening of the matchers shows up in CI.
 */

import { describe, expect, it } from "vitest";
import {
  buildCorrectionText,
  checkHallucinationGuard,
  detectFalseToolReport,
  extractPersonName,
  getLastUserText,
  getMessageText,
  hasToolUse,
  readEnvConfig,
  runHallucinationGuardInline,
  type HallucinationGuardConfig,
  type MemoryShResult,
} from "./hallucination-guard.js";

function gemmaConfig(overrides: Partial<HallucinationGuardConfig> = {}): HallucinationGuardConfig {
  return {
    enabled: true,
    agents: new Set(["gemma"]),
    timeoutMs: 5000,
    memoryShPath: "/tmp/memory.sh",
    fallbackChatId: "8324629902",
    fallbackApi: "http://127.0.0.1:9087/api/send",
    logLevel: "info",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// U1 — extractPersonName: P1–P5 + blacklist + non-hangul
// ---------------------------------------------------------------------------

describe("U1 extractPersonName", () => {
  it("matches P1 — '누구야' form", () => {
    expect(extractPersonName("황선아가 누구야?")?.name).toBe("황선아");
  });
  it("matches P2 — '알지?' form", () => {
    expect(extractPersonName("황선아라고 알지?")?.name).toBe("황선아");
  });
  it("matches P3 — '어떤 사람' form", () => {
    expect(extractPersonName("황선아 어떤 사람이야?")?.name).toBe("황선아");
  });
  it("matches P4 — '에 대해 알려줘' form", () => {
    expect(extractPersonName("정유진에 대해 알려줘")?.name).toBe("정유진");
  });
  it("matches P5 — '은/는 누구' form", () => {
    expect(extractPersonName("이서현은 누구야")?.name).toBe("이서현");
  });
  it("rejects blacklisted '오늘'", () => {
    // P1 matches '오늘은 누구야' but the captured token '오늘' is in the
    // blacklist; downstream patterns should also miss → null.
    expect(extractPersonName("오늘은 누구야?")).toBeNull();
  });
  it("rejects English-only names (MVP scope D15 — hangul only)", () => {
    expect(extractPersonName("Kevin 알아?")).toBeNull();
  });
  it("returns null for non-person sentences", () => {
    expect(extractPersonName("잘 있지?")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// U2 — detectFalseToolReport: F1–F8 + clean text
// ---------------------------------------------------------------------------

describe("U2 detectFalseToolReport", () => {
  it.each([
    ["F1: 메모리를 검색", "메모리를 검색해 봤는데 없었어"],
    ["F2: 검색해 봤어", "방금 검색해 봤지만 결과가 없어"],
    ["F3: 기억이 없", "내 기억이 없어"],
    ["F4: 기록이 없", "관련 기록이 없네"],
    ["F5: 정보가 없", "정보가 없어"],
    ["F6: memory_search()", "memory_search 했지만 hit 없음"],
    ["F7: Snippet 내용을 바탕으로", "Snippet 내용을 바탕으로 정리하면"],
    ["F8: 파일을 확인해 봤", "파일을 확인해 봤지만 없었어"],
  ])("matches %s", (_label, text) => {
    expect(detectFalseToolReport(text)).toBe(true);
  });
  it("does not match clean assistant text", () => {
    expect(detectFalseToolReport("잘 지내고 있어. 오늘도 화이팅!")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// U3 — hasToolUse + getMessageText (content shape helpers)
// ---------------------------------------------------------------------------

describe("U3 hasToolUse / getMessageText", () => {
  it("returns true when content has a tool_use block", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "calling tool" },
        { type: "tool_use", name: "read", input: {} },
      ],
    };
    expect(hasToolUse(message)).toBe(true);
  });
  it("returns false for text-only content", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "메모리를 검색해 봤는데 없어" }],
    };
    expect(hasToolUse(message)).toBe(false);
  });
  it("getMessageText concatenates all text blocks", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "첫번째" },
        { type: "text", text: "두번째" },
      ],
    };
    expect(getMessageText(message)).toBe("첫번째\n두번째");
  });
  it("getLastUserText finds the latest user message", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "안녕" }] },
      { role: "assistant", content: [{ type: "text", text: "응 안녕" }] },
      { role: "user", content: [{ type: "text", text: "황선아라고 알지?" }] },
    ];
    expect(getLastUserText(messages)).toBe("황선아라고 알지?");
  });
});

// ---------------------------------------------------------------------------
// U4 — checkHallucinationGuard: AND-of-4 trigger
// ---------------------------------------------------------------------------

describe("U4 checkHallucinationGuard", () => {
  const userMsg = {
    role: "user",
    content: [{ type: "text", text: "황선아라고 알지?" }],
  };
  const hallucinatedAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "메모리를 검색해 봤는데 기억이 없어" }],
  };

  it("triggers when all four conditions hold", () => {
    const result = checkHallucinationGuard({
      agentId: "gemma",
      messages: [userMsg, hallucinatedAssistant],
      lastAssistant: hallucinatedAssistant,
      config: gemmaConfig(),
    });
    expect(result.triggered).toBe(true);
    if (result.triggered) {
      expect(result.personName).toBe("황선아");
    }
  });

  it("does not trigger when guard is disabled", () => {
    const result = checkHallucinationGuard({
      agentId: "gemma",
      messages: [userMsg, hallucinatedAssistant],
      lastAssistant: hallucinatedAssistant,
      config: gemmaConfig({ enabled: false }),
    });
    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toBe("disabled");
    }
  });

  it("does not trigger for non-whitelisted agent", () => {
    const result = checkHallucinationGuard({
      agentId: "main",
      messages: [userMsg, hallucinatedAssistant],
      lastAssistant: hallucinatedAssistant,
      config: gemmaConfig(),
    });
    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toBe("agent-not-in-whitelist");
    }
  });

  it("does not trigger when user message lacks a person name", () => {
    const benignUser = {
      role: "user",
      content: [{ type: "text", text: "잘 있지?" }],
    };
    const result = checkHallucinationGuard({
      agentId: "gemma",
      messages: [benignUser, hallucinatedAssistant],
      lastAssistant: hallucinatedAssistant,
      config: gemmaConfig(),
    });
    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toBe("no-person-pattern");
    }
  });

  it("does not trigger when assistant invoked a tool", () => {
    const toolUsingAssistant = {
      role: "assistant",
      content: [
        { type: "text", text: "메모리를 검색해 봤어" },
        { type: "tool_use", name: "read", input: { path: "people/황선아.md" } },
      ],
    };
    const result = checkHallucinationGuard({
      agentId: "gemma",
      messages: [userMsg, toolUsingAssistant],
      lastAssistant: toolUsingAssistant,
      config: gemmaConfig(),
    });
    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toBe("has-tool-use");
    }
  });

  it("does not trigger when assistant text contains no false-tool-report keyword", () => {
    const cleanAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "황선아는 우리 회사 신입사원이야. 친절해." }],
    };
    const result = checkHallucinationGuard({
      agentId: "gemma",
      messages: [userMsg, cleanAssistant],
      lastAssistant: cleanAssistant,
      config: gemmaConfig(),
    });
    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toBe("no-false-report");
    }
  });
});

// ---------------------------------------------------------------------------
// U5 — runHallucinationGuardInline with mock memory.sh + sender
// ---------------------------------------------------------------------------

describe("U5 runHallucinationGuardInline", () => {
  const userMsg = {
    role: "user",
    content: [{ type: "text", text: "황선아라고 알지?" }],
  };
  const hallucinatedAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "메모리를 검색해 봤는데 기억이 없어" }],
  };

  it("runs memory.sh and posts fallback on trigger", async () => {
    const memoryCalls: string[] = [];
    const sendCalls: Array<{ chatId: string; text: string }> = [];
    const result = await runHallucinationGuardInline({
      agentId: "gemma",
      messages: [userMsg, hallucinatedAssistant],
      lastAssistant: hallucinatedAssistant,
      config: gemmaConfig(),
      runMemoryShFn: async (_path, name) => {
        memoryCalls.push(name);
        const ok: MemoryShResult = {
          status: "ok",
          matches: 2,
          stdout: "match line\nRESULT: OK | matches: 2",
        };
        return ok;
      },
      sendFallbackFn: async (_api, chatId, text) => {
        sendCalls.push({ chatId, text });
        return { ok: true, status: 200 };
      },
    });
    expect(result.triggered).toBe(true);
    expect(result.memoryStatus).toBe("ok");
    expect(result.fallbackSent).toBe(true);
    expect(memoryCalls).toEqual(["황선아"]);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.chatId).toBe("8324629902");
    expect(sendCalls[0]?.text).toContain("(가드)");
    expect(sendCalls[0]?.text).toContain("황선아");
  });

  it("does not call memory.sh or fallback when not triggered", async () => {
    let memoryCalled = false;
    let sendCalled = false;
    const result = await runHallucinationGuardInline({
      agentId: "kevin",
      messages: [userMsg, hallucinatedAssistant],
      lastAssistant: hallucinatedAssistant,
      config: gemmaConfig(),
      runMemoryShFn: async () => {
        memoryCalled = true;
        return { status: "ok", matches: 0, stdout: "" };
      },
      sendFallbackFn: async () => {
        sendCalled = true;
        return { ok: true, status: 200 };
      },
    });
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("agent-not-in-whitelist");
    expect(memoryCalled).toBe(false);
    expect(sendCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildCorrectionText (kept inline — small surface)
// ---------------------------------------------------------------------------

describe("buildCorrectionText", () => {
  it("includes the memory.sh stdout on ok status", () => {
    const text = buildCorrectionText("황선아", {
      status: "ok",
      matches: 1,
      stdout: "people/황선아.md\nRESULT: OK | matches: 1",
    });
    expect(text).toContain("(가드)");
    expect(text).toContain("황선아");
    expect(text).toContain("memory.sh");
  });
  it("emits a not-found fallback on failed status", () => {
    const text = buildCorrectionText("이존재안함", {
      status: "failed",
      reason: "matches=0",
      stdout: "",
    });
    expect(text).toContain("못 찾았어");
    expect(text).toContain("이존재안함");
  });
});

// ---------------------------------------------------------------------------
// readEnvConfig (env parsing surface)
// ---------------------------------------------------------------------------

describe("readEnvConfig", () => {
  it("defaults to enabled + gemma-only", () => {
    const cfg = readEnvConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.agents.has("gemma")).toBe(true);
  });
  it("honours OPENCLAW_HALLUCINATION_GUARD_ENABLED=0", () => {
    const cfg = readEnvConfig({ OPENCLAW_HALLUCINATION_GUARD_ENABLED: "0" });
    expect(cfg.enabled).toBe(false);
  });
  it("parses agent whitelist from comma-separated env", () => {
    const cfg = readEnvConfig({ OPENCLAW_HALLUCINATION_GUARD_AGENTS: "gemma, kevin" });
    expect(cfg.agents.has("gemma")).toBe(true);
    expect(cfg.agents.has("kevin")).toBe(true);
  });
});
