import { afterEach, describe, expect, it } from "vitest";
import {
  OCG_APPROVE_CALLBACK_DATA,
  __testing,
  checkMutationGate,
  clearMutationApproval,
  recordMutationApproval,
} from "./mutation-gate.js";

const {
  MUTATION_APPROVALS,
  DEFAULT_MUTATION_TOOLS,
  DEFAULT_GATE_CHANNELS,
  DM_SCOPE_SEGMENTS,
  isMemoryFileWrite,
  extractChannelFromSessionKey,
} = __testing;

afterEach(() => {
  MUTATION_APPROVALS.clear();
});

describe("checkMutationGate", () => {
  const baseArgs = {
    sessionKey: "agent:dev:telegram:group:-100123:topic:42",
    config: { enabled: true },
  };

  it("allows all tools when gate is disabled", () => {
    const result = checkMutationGate({
      toolName: "gateway",
      params: {},
      sessionKey: baseArgs.sessionKey,
      config: { enabled: false },
    });
    expect(result.allowed).toBe(true);
  });

  it("allows non-mutation tools without approval", () => {
    const nonMutations = [
      "read",
      "web_search",
      "web_fetch",
      "memory_search",
      "memory_get",
      "sessions_list",
      "sessions_history",
      "session_status",
      "agents_list",
      "image",
      "browser",
      "sessions_send",
      "sessions_spawn",
      "subagents",
      "tts",
      "canvas",
      "nodes",
      "pdf",
    ];
    for (const tool of nonMutations) {
      const result = checkMutationGate({
        toolName: tool,
        params: {},
        ...baseArgs,
      });
      expect(result.allowed, `expected ${tool} to be allowed`).toBe(true);
    }
  });

  it("allows dual-use tools (exec, process, write, edit, cron) without approval by default", () => {
    for (const tool of ["exec", "process", "write", "edit", "cron"]) {
      const result = checkMutationGate({
        toolName: tool,
        params: tool === "write" ? { file_path: "/tmp/foo" } : {},
        ...baseArgs,
      });
      expect(result.allowed, `expected ${tool} to be allowed by default`).toBe(true);
    }
  });

  it("blocks all default mutation tools without approval", () => {
    for (const tool of DEFAULT_MUTATION_TOOLS) {
      const result = checkMutationGate({
        toolName: tool,
        params: {},
        ...baseArgs,
      });
      expect(result.allowed, `expected ${tool} to be blocked`).toBe(false);
    }
  });

  it("blocks gateway tool with correct error message", () => {
    const result = checkMutationGate({
      toolName: "gateway",
      params: { action: "restart" },
      ...baseArgs,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("Mutation blocked");
      expect(result.reason).toContain(OCG_APPROVE_CALLBACK_DATA);
    }
  });

  it("allows mutation after approval (one-shot)", () => {
    recordMutationApproval(baseArgs.sessionKey, "463420978");
    const result = checkMutationGate({
      toolName: "gateway",
      params: { action: "restart" },
      ...baseArgs,
    });
    expect(result.allowed).toBe(true);
  });

  it("consumes approval after one use", () => {
    recordMutationApproval(baseArgs.sessionKey, "463420978");
    // First call consumes the approval
    checkMutationGate({ toolName: "gateway", params: {}, ...baseArgs });
    // Second call has no approval left
    const result = checkMutationGate({ toolName: "gateway", params: {}, ...baseArgs });
    expect(result.allowed).toBe(false);
  });

  it("each mutation needs its own approval", () => {
    recordMutationApproval(baseArgs.sessionKey, "463420978");
    const r1 = checkMutationGate({
      toolName: "apply_patch",
      params: {},
      ...baseArgs,
    });
    expect(r1.allowed).toBe(true);

    // Next mutation blocked — need another click
    const r2 = checkMutationGate({ toolName: "gateway", params: {}, ...baseArgs });
    expect(r2.allowed).toBe(false);

    // New approval for second mutation
    recordMutationApproval(baseArgs.sessionKey, "463420978");
    const r3 = checkMutationGate({ toolName: "gateway", params: {}, ...baseArgs });
    expect(r3.allowed).toBe(true);
  });

  it("extraMutations adds to defaults (does not replace)", () => {
    // gateway is a default — still gated even though extraMutations only lists "exec"
    const r1 = checkMutationGate({
      toolName: "gateway",
      params: {},
      sessionKey: baseArgs.sessionKey,
      config: { enabled: true, extraMutations: ["exec"] },
    });
    expect(r1.allowed).toBe(false);

    // exec is now also gated via extraMutations
    const r2 = checkMutationGate({
      toolName: "exec",
      params: {},
      sessionKey: baseArgs.sessionKey,
      config: { enabled: true, extraMutations: ["exec"] },
    });
    expect(r2.allowed).toBe(false);
  });

  it("extraMutations can add non-default tools", () => {
    // exec is not in defaults — adding via extraMutations gates it
    const result = checkMutationGate({
      toolName: "exec",
      params: {},
      sessionKey: baseArgs.sessionKey,
      config: { enabled: true, extraMutations: ["exec"] },
    });
    expect(result.allowed).toBe(false);
  });

  it("extraMutations can re-gate write, edit, exec, and process", () => {
    for (const tool of ["write", "edit", "exec", "process"]) {
      const result = checkMutationGate({
        toolName: tool,
        params: tool === "write" ? { file_path: "/tmp/foo" } : {},
        sessionKey: baseArgs.sessionKey,
        config: { enabled: true, extraMutations: ["write", "edit", "exec", "process"] },
      });
      expect(result.allowed, `expected ${tool} to be blocked via extraMutations`).toBe(false);
    }
  });

  it("defaults are always gated even without extraMutations", () => {
    for (const tool of DEFAULT_MUTATION_TOOLS) {
      const result = checkMutationGate({
        toolName: tool,
        params: {},
        sessionKey: baseArgs.sessionKey,
        config: { enabled: true },
      });
      expect(result.allowed, `expected default tool ${tool} to be blocked`).toBe(false);
    }
  });

  it("default mutation tools are gateway and apply_patch only", () => {
    expect([...DEFAULT_MUTATION_TOOLS].toSorted()).toEqual(["apply_patch", "gateway"]);
  });

  it("clears approval via clearMutationApproval", () => {
    recordMutationApproval(baseArgs.sessionKey, "463420978");
    clearMutationApproval(baseArgs.sessionKey);
    const result = checkMutationGate({ toolName: "gateway", params: {}, ...baseArgs });
    expect(result.allowed).toBe(false);
  });
});

describe("checkMutationGate autonomous session bypass", () => {
  it("allows cron session key even for mutation tools", () => {
    const result = checkMutationGate({
      toolName: "gateway",
      params: {},
      sessionKey: "agent:main:cron:daily-summary",
      config: { enabled: true },
    });
    expect(result.allowed).toBe(true);
  });

  it("allows cron run session key even for mutation tools", () => {
    const result = checkMutationGate({
      toolName: "gateway",
      params: {},
      sessionKey: "agent:main:cron:daily-summary:run:abc123",
      config: { enabled: true },
    });
    expect(result.allowed).toBe(true);
  });

  it("allows cron session even with extraMutations", () => {
    const result = checkMutationGate({
      toolName: "exec",
      params: {},
      sessionKey: "agent:main:cron:job-1",
      config: { enabled: true, extraMutations: ["exec"] },
    });
    expect(result.allowed).toBe(true);
  });

  it("subagent sessions already bypass via DM_SCOPE_SEGMENTS", () => {
    const result = checkMutationGate({
      toolName: "gateway",
      params: {},
      sessionKey: "agent:dev:subagent:550e8400-e29b-41d4-a716-446655440000",
      config: { enabled: true },
    });
    expect(result.allowed).toBe(true);
  });

  it("interactive telegram session still requires approval", () => {
    const result = checkMutationGate({
      toolName: "gateway",
      params: {},
      sessionKey: "agent:dev:telegram:group:-100123:topic:624",
      config: { enabled: true },
    });
    expect(result.allowed).toBe(false);
  });
});

describe("checkMutationGate channel scoping", () => {
  it("skips gate for non-telegram channels by default", () => {
    const result = checkMutationGate({
      toolName: "gateway",
      params: {},
      sessionKey: "agent:dev:discord:guild:123:channel:456",
      config: { enabled: true },
    });
    expect(result.allowed).toBe(true);
  });

  it("enforces gate for telegram sessions", () => {
    const result = checkMutationGate({
      toolName: "gateway",
      params: {},
      sessionKey: "agent:dev:telegram:group:-100123:topic:42",
      config: { enabled: true },
    });
    expect(result.allowed).toBe(false);
  });

  it("config channels overrides default", () => {
    // Enforce on discord instead of telegram
    const result = checkMutationGate({
      toolName: "gateway",
      params: {},
      sessionKey: "agent:dev:discord:guild:123:channel:456",
      config: { enabled: true, channels: ["discord"] },
    });
    expect(result.allowed).toBe(false);
  });

  it("allows telegram when config channels excludes it", () => {
    const result = checkMutationGate({
      toolName: "gateway",
      params: {},
      sessionKey: "agent:dev:telegram:group:-100123:topic:42",
      config: { enabled: true, channels: ["discord"] },
    });
    expect(result.allowed).toBe(true);
  });

  it("default gate channels is telegram only", () => {
    expect(DEFAULT_GATE_CHANNELS).toEqual(["telegram"]);
  });

  it("allows DM session key with main scope (provider unknown, no buttons)", () => {
    // "agent:<id>:main" — no provider in key, can't present approval buttons
    const result = checkMutationGate({
      toolName: "gateway",
      params: {},
      sessionKey: "agent:dev:main",
      config: { enabled: true },
    });
    expect(result.allowed).toBe(true);
  });

  it("allows DM session key with direct scope (provider unknown, no buttons)", () => {
    // "agent:<id>:direct:<peer>" — no provider in key, can't present approval buttons
    const result = checkMutationGate({
      toolName: "gateway",
      params: {},
      sessionKey: "agent:dev:direct:463420978",
      config: { enabled: true },
    });
    expect(result.allowed).toBe(true);
  });

  it("allows subagent session key (provider unknown, no buttons)", () => {
    // "agent:<id>:subagent:<uuid>" — no provider in key, can't present approval buttons
    const result = checkMutationGate({
      toolName: "gateway",
      params: {},
      sessionKey: "agent:dev:subagent:550e8400-e29b-41d4-a716-446655440000",
      config: { enabled: true },
    });
    expect(result.allowed).toBe(true);
  });

  it("allows non-telegram DM sessions when channels=[telegram]", () => {
    // DM session keys don't carry provider — gate must not apply since
    // there's no way to present Telegram inline buttons
    const result = checkMutationGate({
      toolName: "gateway",
      params: {},
      sessionKey: "agent:dev:main",
      config: { enabled: true, channels: ["telegram"] },
    });
    expect(result.allowed).toBe(true);
  });

  it("enforces gate for per-channel-peer DM key with gated channel", () => {
    // "agent:<id>:telegram:direct:<peer>" — provider IS in the key
    const result = checkMutationGate({
      toolName: "gateway",
      params: {},
      sessionKey: "agent:dev:telegram:direct:463420978",
      config: { enabled: true },
    });
    expect(result.allowed).toBe(false);
  });

  it("DM scope segments constant includes main, direct, and subagent", () => {
    expect(DM_SCOPE_SEGMENTS.has("main")).toBe(true);
    expect(DM_SCOPE_SEGMENTS.has("direct")).toBe(true);
    expect(DM_SCOPE_SEGMENTS.has("subagent")).toBe(true);
  });
});

describe("extractChannelFromSessionKey", () => {
  it("extracts telegram from group session key", () => {
    expect(extractChannelFromSessionKey("agent:dev:telegram:group:-100123:topic:42")).toBe(
      "telegram",
    );
  });

  it("extracts discord from guild session key", () => {
    expect(extractChannelFromSessionKey("agent:dev:discord:guild:123:channel:456")).toBe("discord");
  });

  it("returns undefined for short keys", () => {
    expect(extractChannelFromSessionKey("agent:dev")).toBeUndefined();
  });

  it("normalizes to lowercase", () => {
    expect(extractChannelFromSessionKey("agent:dev:Telegram:group:123")).toBe("telegram");
  });
});

describe("isMemoryFileWrite", () => {
  const workspace = "/home/user/.openclaw/agents/dev/agent";

  it("allows MEMORY.md write in agent workspace", () => {
    expect(isMemoryFileWrite("write", { file_path: `${workspace}/MEMORY.md` }, workspace)).toBe(
      true,
    );
  });

  it("allows memory subdir write in agent workspace", () => {
    expect(
      isMemoryFileWrite("write", { file_path: `${workspace}/memory/notes.md` }, workspace),
    ).toBe(true);
  });

  it("rejects MEMORY.md outside agent workspace", () => {
    expect(isMemoryFileWrite("write", { file_path: "/tmp/MEMORY.md" }, workspace)).toBe(false);
  });

  it("rejects non-write tools", () => {
    expect(isMemoryFileWrite("exec", { file_path: `${workspace}/MEMORY.md` }, workspace)).toBe(
      false,
    );
  });

  it("rejects non-md files in memory dir", () => {
    expect(
      isMemoryFileWrite("write", { file_path: `${workspace}/memory/data.json` }, workspace),
    ).toBe(false);
  });

  it("rejects MEMORY.md without workspace constraint", () => {
    expect(isMemoryFileWrite("write", { file_path: "/any/path/MEMORY.md" })).toBe(false);
  });

  it("allows edit tool targeting memory files", () => {
    expect(isMemoryFileWrite("edit", { file_path: `${workspace}/MEMORY.md` }, workspace)).toBe(
      true,
    );
  });

  it("allows relative MEMORY.md path (model-supplied)", () => {
    expect(isMemoryFileWrite("write", { file_path: "MEMORY.md" }, workspace)).toBe(true);
  });

  it("allows relative memory subdir path (model-supplied)", () => {
    expect(isMemoryFileWrite("write", { file_path: "memory/2026-03-04.md" }, workspace)).toBe(true);
  });

  it("rejects path traversal escaping workspace", () => {
    expect(
      isMemoryFileWrite("write", { file_path: "memory/../../tmp/payload.md" }, workspace),
    ).toBe(false);
  });

  it("rejects absolute path traversal escaping workspace", () => {
    expect(
      isMemoryFileWrite(
        "write",
        { file_path: `${workspace}/memory/../../tmp/payload.md` },
        workspace,
      ),
    ).toBe(false);
  });

  it("accepts canonical path param (normalized form)", () => {
    expect(isMemoryFileWrite("write", { path: `${workspace}/MEMORY.md` }, workspace)).toBe(true);
  });

  it("prefers file_path over path when both present", () => {
    expect(
      isMemoryFileWrite(
        "write",
        { file_path: `${workspace}/MEMORY.md`, path: "/tmp/evil.md" },
        workspace,
      ),
    ).toBe(true);
  });

  describe("Windows-style paths", () => {
    // path.isAbsolute / path.normalize / path.sep handle platform differences,
    // but on POSIX hosts path.sep is "/".  We test that the logic works with
    // the native separator — the important thing is that we no longer hardcode
    // "/" in comparisons.  The reviewer's concern is addressed by using
    // path.isAbsolute + path.sep throughout, which will do the right thing on
    // Windows at runtime.

    it("allows MEMORY.md via path.join-style workspace", () => {
      const ws = "/agents/dev";
      expect(isMemoryFileWrite("write", { file_path: `${ws}/MEMORY.md` }, ws)).toBe(true);
    });

    it("allows memory subdir via path.join-style workspace", () => {
      const ws = "/agents/dev";
      expect(isMemoryFileWrite("write", { file_path: `${ws}/memory/notes.md` }, ws)).toBe(true);
    });

    it("rejects MEMORY.md outside workspace via path.join-style", () => {
      const ws = "/agents/dev";
      expect(isMemoryFileWrite("write", { file_path: "/other/MEMORY.md" }, ws)).toBe(false);
    });
  });
});

describe("checkMutationGate memory file exception", () => {
  it("allows write to MEMORY.md without approval when write is gated via extraMutations", () => {
    const result = checkMutationGate({
      toolName: "write",
      params: { file_path: "/home/user/.openclaw/agents/dev/agent/MEMORY.md", content: "test" },
      sessionKey: "agent:dev:telegram:group:-100123:topic:42",
      config: { enabled: true, extraMutations: ["write"] },
      agentWorkspace: "/home/user/.openclaw/agents/dev/agent",
    });
    expect(result.allowed).toBe(true);
  });

  it("blocks write to non-memory file without approval when write is gated", () => {
    const result = checkMutationGate({
      toolName: "write",
      params: { file_path: "/home/user/.openclaw/agents/dev/agent/config.json", content: "{}" },
      sessionKey: "agent:dev:telegram:group:-100123:topic:42",
      config: { enabled: true, extraMutations: ["write"] },
      agentWorkspace: "/home/user/.openclaw/agents/dev/agent",
    });
    expect(result.allowed).toBe(false);
  });

  it("blocks memory write when agentWorkspace is not set", () => {
    const result = checkMutationGate({
      toolName: "write",
      params: { file_path: "/any/path/MEMORY.md", content: "test" },
      sessionKey: "agent:dev:telegram:group:-100123:topic:42",
      config: { enabled: true, extraMutations: ["write"] },
    });
    expect(result.allowed).toBe(false);
  });

  it("allows memory subdir write without approval when write is gated", () => {
    const result = checkMutationGate({
      toolName: "write",
      params: {
        file_path: "/home/user/.openclaw/agents/dev/agent/memory/2026-03-05.md",
        content: "notes",
      },
      sessionKey: "agent:dev:telegram:group:-100123:topic:42",
      config: { enabled: true, extraMutations: ["write"] },
      agentWorkspace: "/home/user/.openclaw/agents/dev/agent",
    });
    expect(result.allowed).toBe(true);
  });

  it("blocks memory write to path outside agent workspace", () => {
    const result = checkMutationGate({
      toolName: "write",
      params: { file_path: "/other/path/MEMORY.md", content: "test" },
      sessionKey: "agent:dev:telegram:group:-100123:topic:42",
      config: { enabled: true, extraMutations: ["write"] },
      agentWorkspace: "/home/user/.openclaw/agents/dev/agent",
    });
    expect(result.allowed).toBe(false);
  });
});
