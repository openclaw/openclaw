/**
 * PR-15: tests for the pending-agent-injection consumer.
 *
 * The gateway writes `SessionEntry.pendingAgentInjection` whenever
 * `sessions.patch { planApproval: { action: ... } }` fires. This
 * consumer reads + clears the field atomically so the injection only
 * fires once, and composes it into the agent's next-turn prompt.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the config + path resolution so the test stays hermetic
// (doesn't depend on the user's real ~/.openclaw store).
const tmpStorePath = vi.hoisted(() => ({ value: "" }));
vi.mock("../../config/io.js", () => ({
  loadConfig: () => ({ session: { store: tmpStorePath.value } }),
}));
vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: (configValue: string | undefined) => configValue ?? tmpStorePath.value,
}));
vi.mock("../../routing/session-key.js", () => ({
  parseAgentSessionKey: (k: string) => {
    const m = /^agent:([^:]+):/.exec(k);
    return m ? { agentId: m[1] } : undefined;
  },
}));

// Import AFTER the mocks so the module captures the mocked imports.
import {
  composePromptWithPendingInjection,
  consumePendingAgentInjection,
} from "./pending-injection.js";

describe("composePromptWithPendingInjection (PR-15)", () => {
  it("returns the user prompt unchanged when no injection is pending", () => {
    const result = composePromptWithPendingInjection(undefined, "do the thing");
    expect(result).toBe("do the thing");
  });

  it("returns the user prompt unchanged when injection is empty string", () => {
    // Falsy guard: empty string isn't a valid injection.
    const result = composePromptWithPendingInjection("", "do the thing");
    expect(result).toBe("do the thing");
  });

  it("prepends the injection with two-newline separator when both present", () => {
    const result = composePromptWithPendingInjection("[QUESTION_ANSWER]: yes", "next step please");
    expect(result).toBe("[QUESTION_ANSWER]: yes\n\nnext step please");
  });

  it("returns just the injection when user prompt is empty (no extra newlines)", () => {
    const result = composePromptWithPendingInjection("[PLAN_DECISION]: approved", "");
    expect(result).toBe("[PLAN_DECISION]: approved");
  });

  it("returns just the injection when user prompt is whitespace-only", () => {
    const result = composePromptWithPendingInjection("[PLAN_DECISION]: approved", "   \n  ");
    expect(result).toBe("[PLAN_DECISION]: approved");
  });

  it("trims the user prompt before composing (preserves injection format)", () => {
    const result = composePromptWithPendingInjection(
      "[QUESTION_ANSWER]: option-a",
      "  follow-up question  \n",
    );
    expect(result).toBe("[QUESTION_ANSWER]: option-a\n\nfollow-up question");
  });
});

describe("consumePendingAgentInjection (PR-15)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pending-injection-"));
    tmpStorePath.value = path.join(tmpDir, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function writeStore(sessionKey: string, entry: Record<string, unknown>): Promise<void> {
    const store = { [sessionKey]: { sessionId: "test-session", updatedAt: 0, ...entry } };
    return fs.writeFile(tmpStorePath.value, JSON.stringify(store), "utf8");
  }

  async function readStore(sessionKey: string): Promise<Record<string, unknown> | undefined> {
    const raw = await fs.readFile(tmpStorePath.value, "utf8");
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    return parsed[sessionKey];
  }

  it("returns undefined text when no injection is pending", async () => {
    await writeStore("agent:main:session-x", { sessionId: "s1", updatedAt: 1 });
    const result = await consumePendingAgentInjection("agent:main:session-x");
    expect(result.text).toBeUndefined();
  });

  it("returns undefined text when sessionKey is empty", async () => {
    const result = await consumePendingAgentInjection("");
    expect(result.text).toBeUndefined();
  });

  it("reads + clears a pending injection (once-and-only-once contract)", async () => {
    await writeStore("agent:main:session-x", {
      sessionId: "s1",
      updatedAt: 1,
      pendingAgentInjection: "[QUESTION_ANSWER]: yes",
    });
    const first = await consumePendingAgentInjection("agent:main:session-x");
    expect(first.text).toBe("[QUESTION_ANSWER]: yes");
    // Verify the field was cleared on disk.
    const entryAfter = await readStore("agent:main:session-x");
    expect(entryAfter?.pendingAgentInjection).toBeUndefined();
    // A second call returns undefined — the once-and-only-once guarantee.
    const second = await consumePendingAgentInjection("agent:main:session-x");
    expect(second.text).toBeUndefined();
  });

  it("returns undefined when sessionKey doesn't exist in store (no throw)", async () => {
    await writeStore("agent:main:other-session", { sessionId: "s1", updatedAt: 1 });
    const result = await consumePendingAgentInjection("agent:main:nonexistent");
    expect(result.text).toBeUndefined();
  });

  it("preserves other SessionEntry fields when clearing the injection", async () => {
    await writeStore("agent:main:session-x", {
      sessionId: "s1",
      updatedAt: 1,
      execHost: "local",
      execSecurity: "deny",
      pendingAgentInjection: "[PLAN_DECISION]: approved",
      planMode: { mode: "plan", approval: "approved", rejectionCount: 0 },
    });
    const result = await consumePendingAgentInjection("agent:main:session-x");
    expect(result.text).toBe("[PLAN_DECISION]: approved");
    const entryAfter = await readStore("agent:main:session-x");
    expect(entryAfter?.pendingAgentInjection).toBeUndefined();
    expect(entryAfter?.execHost).toBe("local");
    expect(entryAfter?.execSecurity).toBe("deny");
    expect(entryAfter?.planMode).toBeDefined();
  });

  it("does not throw when the store write fails (best-effort with optional log)", async () => {
    // Point the store at a path that's a directory (so opening it as a
    // file fails). The consumer is wrapped in try/catch and returns
    // undefined rather than propagating — best-effort by design so a
    // store-write failure can't crash the agent run.
    tmpStorePath.value = tmpDir; // directory, not a file
    const warn = vi.fn();
    const result = await consumePendingAgentInjection("agent:main:session-x", { warn });
    expect(result.text).toBeUndefined();
    // The warn callback may or may not fire depending on the underlying
    // store implementation's behavior — the contract is "no throw, no
    // injection delivered". Both are covered.
  });
});
