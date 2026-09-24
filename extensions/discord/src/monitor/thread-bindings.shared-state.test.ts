// Discord tests cover thread bindings.shared state plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import { createThreadBindingManager, getThreadBindingManager } from "./thread-bindings.js";
import { resetThreadBindingsForTests } from "./thread-bindings.test-support.js";

type ThreadBindingsModule = {
  getThreadBindingManager: typeof getThreadBindingManager;
};

async function loadThreadBindingsViaAlternateLoader(): Promise<ThreadBindingsModule> {
  const fallbackPath = "./thread-bindings.ts?vitest-loader-fallback";
  return (await import(/* @vite-ignore */ fallbackPath)) as ThreadBindingsModule;
}

describe("thread binding manager state", () => {
  beforeEach(async () => {
    await resetThreadBindingsForTests();
  });

  it("shares managers between ESM and alternate-loaded module instances", async () => {
    const viaAlternateLoader = await loadThreadBindingsViaAlternateLoader();

    await createThreadBindingManager({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "work",
      persist: false,
      enableSweeper: false,
    });

    const direct = getThreadBindingManager("work");
    if (!direct) {
      throw new Error("expected direct thread binding manager");
    }
    expect(viaAlternateLoader.getThreadBindingManager("work")).toBe(direct);
  });

  it("reuses predecessor state across source reloads without losing account scheduling", async () => {
    const stateKey = Symbol.for("openclaw.discordThreadBindingsState");
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    const { THREAD_BINDINGS_STATE: originalState } = await import("./thread-bindings.state.js");
    const predecessor = { ...originalState };
    Reflect.deleteProperty(predecessor, "accountOperationTails");
    globalStore[stateKey] = predecessor;

    try {
      vi.resetModules();
      const first = await import("./thread-bindings.manager.js");
      const { THREAD_BINDINGS_STATE: firstState } = await import("./thread-bindings.state.js");
      expect(firstState).toBe(predecessor);
      const manager = await first.createThreadBindingManager({
        cfg: EMPTY_DISCORD_TEST_CONFIG,
        accountId: "work",
        persist: false,
        enableSweeper: false,
      });
      await expect(
        manager.bindTarget({
          threadId: "channel:reload-fixture",
          channelId: "channel:reload-fixture",
          targetKind: "subagent",
          targetSessionKey: "agent:main:subagent:reload-fixture",
          agentId: "main",
        }),
      ).resolves.toMatchObject({ targetSessionKey: "agent:main:subagent:reload-fixture" });
      const accountTails = firstState.accountOperationTails;
      await manager.stop();
      expect(first.getThreadBindingManager("work")).toBeNull();

      vi.resetModules();
      const second = await import("./thread-bindings.manager.js");
      const { THREAD_BINDINGS_STATE: secondState } = await import("./thread-bindings.state.js");
      expect(secondState).toBe(predecessor);
      expect(secondState.accountOperationTails).toBe(accountTails);
      const replacement = await second.createThreadBindingManager({
        cfg: EMPTY_DISCORD_TEST_CONFIG,
        accountId: "work",
        persist: false,
        enableSweeper: false,
      });
      const at = Date.now() + 1_000;
      await expect(
        replacement.touchThread({ threadId: "channel:reload-fixture", at, persist: false }),
      ).resolves.toMatchObject({ lastActivityAt: at });
      await replacement.stop();
      expect(second.getThreadBindingManager("work")).toBeNull();
    } finally {
      // The missing-map regression must not leave a manager that teardown cannot drain.
      predecessor.accountOperationTails ??= new WeakMap();
      try {
        await resetThreadBindingsForTests();
      } finally {
        globalStore[stateKey] = originalState;
        vi.resetModules();
      }
    }
  });
});
