import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_CLAUDE_CODE_VERSION,
  deferAnthropicClaudeCodeIdentityUntil,
  resetAnthropicClaudeCodeVersionForTests,
  resolveAnthropicClaudeCodeIdentity,
  setAnthropicClaudeCodeVersion,
  snapshotAnthropicClaudeCodeIdentity,
} from "./anthropic-model-contract.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  resetAnthropicClaudeCodeVersionForTests();
});

describe("Anthropic Claude Code identity", () => {
  it("derives the user-agent and the billing block from one version read", () => {
    setAnthropicClaudeCodeVersion("2.1.273");
    const identity = snapshotAnthropicClaudeCodeIdentity();
    expect(identity).toEqual({
      version: "2.1.273",
      userAgent: "claude-cli/2.1.273",
      billingSystemBlock: "x-anthropic-billing-header: cc_version=2.1.273; cc_entrypoint=sdk-cli;",
    });
  });

  it("resolves immediately with the pinned fallback when no startup work is registered", async () => {
    await expect(resolveAnthropicClaudeCodeIdentity()).resolves.toMatchObject({
      version: ANTHROPIC_CLAUDE_CODE_VERSION,
      userAgent: `claude-cli/${ANTHROPIC_CLAUDE_CODE_VERSION}`,
    });
  });

  it("waits for registered startup work and reports the version it adopted", async () => {
    const work = deferred();
    deferAnthropicClaudeCodeIdentityUntil(work.promise);

    let resolved: string | undefined;
    const pending = resolveAnthropicClaudeCodeIdentity().then((identity) => {
      resolved = identity.version;
    });
    await Promise.resolve();
    expect(resolved).toBeUndefined();

    setAnthropicClaudeCodeVersion("2.1.273");
    work.resolve();
    await pending;
    expect(resolved).toBe("2.1.273");
  });

  it("proceeds with what is known once the wait bound elapses", async () => {
    vi.useFakeTimers();
    const never = deferred();
    deferAnthropicClaudeCodeIdentityUntil(never.promise, 1_000);

    const pending = resolveAnthropicClaudeCodeIdentity();
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ version: ANTHROPIC_CLAUDE_CODE_VERSION });
  });

  it("treats failed startup work as nothing adopted, never as a request failure", async () => {
    const work = deferred();
    deferAnthropicClaudeCodeIdentityUntil(work.promise);
    work.reject(new Error("probe exploded"));
    await expect(resolveAnthropicClaudeCodeIdentity()).resolves.toMatchObject({
      version: ANTHROPIC_CLAUDE_CODE_VERSION,
    });
  });
});
