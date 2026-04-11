import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import {
  __testing,
  createSlackThreadBindingManager,
  setSlackThreadBindingIdleTimeoutBySessionKey,
  setSlackThreadBindingMaxAgeBySessionKey,
  unbindSlackThreadBindingsBySessionKey,
} from "./thread-bindings.js";

describe("slack thread bindings", () => {
  let stateDirOverride: string | undefined;

  beforeEach(async () => {
    await __testing.resetSlackThreadBindingsForTests();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await __testing.resetSlackThreadBindingsForTests();
    if (stateDirOverride) {
      delete process.env.OPENCLAW_STATE_DIR;
      fs.rmSync(stateDirOverride, { recursive: true, force: true });
      stateDirOverride = undefined;
    }
  });

  it("registers a slack binding adapter and binds current-thread conversations", async () => {
    const manager = createSlackThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
      idleTimeoutMs: 30_000,
      maxAgeMs: 0,
    });
    const bound = await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-1",
      targetKind: "subagent",
      conversation: {
        channel: "slack",
        accountId: "work",
        conversationId: "1710000000.000100",
        parentConversationId: "C1234567",
      },
      placement: "current",
      metadata: {
        boundBy: "user-1",
      },
    });

    expect(bound.conversation.channel).toBe("slack");
    expect(bound.conversation.accountId).toBe("work");
    expect(bound.conversation.conversationId).toBe("1710000000.000100");
    expect(bound.conversation.parentConversationId).toBe("C1234567");
    expect(bound.targetSessionKey).toBe("agent:main:subagent:child-1");
    expect(
      manager.getByThread({ channelId: "C1234567", threadTs: "1710000000.000100" })?.boundBy,
    ).toBe("user-1");
  });

  it("also accepts the combined channelId:threadTs shape via conversationId alone", async () => {
    const manager = createSlackThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-combined",
      targetKind: "subagent",
      conversation: {
        channel: "slack",
        accountId: "work",
        conversationId: "C7654321:1710000000.000200",
      },
      placement: "current",
    });

    expect(
      manager.getByThread({ channelId: "C7654321", threadTs: "1710000000.000200" })
        ?.targetSessionKey,
    ).toBe("agent:main:subagent:child-combined");
  });

  it("rejects child placement because slack cannot create an empty thread", async () => {
    createSlackThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    await expect(
      getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-1",
        targetKind: "subagent",
        conversation: {
          channel: "slack",
          accountId: "default",
          conversationId: "1710000000.000100",
          parentConversationId: "C1234567",
        },
        placement: "child",
      }),
    ).rejects.toMatchObject({
      code: "BINDING_CAPABILITY_UNSUPPORTED",
    });
  });

  it("rejects current placement when conversationId cannot be split into channelId+threadTs", async () => {
    createSlackThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    await expect(
      getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-bad",
        targetKind: "subagent",
        conversation: {
          channel: "slack",
          accountId: "default",
          conversationId: "1710000000.000100",
        },
        placement: "current",
      }),
    ).rejects.toMatchObject({
      code: "BINDING_CREATE_FAILED",
    });
  });

  it("shares binding state across distinct module instances", async () => {
    const bindingsA = await importFreshModule<typeof import("./thread-bindings.js")>(
      import.meta.url,
      "./thread-bindings.js?scope=shared-a",
    );
    const bindingsB = await importFreshModule<typeof import("./thread-bindings.js")>(
      import.meta.url,
      "./thread-bindings.js?scope=shared-b",
    );

    await bindingsA.__testing.resetSlackThreadBindingsForTests();

    try {
      const managerA = bindingsA.createSlackThreadBindingManager({
        accountId: "shared-runtime",
        persist: false,
        enableSweeper: false,
      });
      const managerB = bindingsB.createSlackThreadBindingManager({
        accountId: "shared-runtime",
        persist: false,
        enableSweeper: false,
      });

      expect(managerB).toBe(managerA);

      await getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-shared",
        targetKind: "subagent",
        conversation: {
          channel: "slack",
          accountId: "shared-runtime",
          conversationId: "1710000000.000300",
          parentConversationId: "C9999999",
        },
        placement: "current",
      });

      expect(
        bindingsB
          .getSlackThreadBindingManager("shared-runtime")
          ?.getByThread({ channelId: "C9999999", threadTs: "1710000000.000300" })?.targetSessionKey,
      ).toBe("agent:main:subagent:child-shared");
    } finally {
      await bindingsA.__testing.resetSlackThreadBindingsForTests();
    }
  });

  it("updates lifecycle windows by session key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
    const manager = createSlackThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-1",
      targetKind: "subagent",
      conversation: {
        channel: "slack",
        accountId: "work",
        conversationId: "1710000000.000400",
        parentConversationId: "C1111111",
      },
    });
    const original = manager.listBySessionKey("agent:main:subagent:child-1")[0];
    expect(original).toBeDefined();

    const idleUpdated = setSlackThreadBindingIdleTimeoutBySessionKey({
      accountId: "work",
      targetSessionKey: "agent:main:subagent:child-1",
      idleTimeoutMs: 2 * 60 * 60 * 1000,
    });
    vi.setSystemTime(new Date("2026-03-06T12:00:00.000Z"));
    const maxAgeUpdated = setSlackThreadBindingMaxAgeBySessionKey({
      accountId: "work",
      targetSessionKey: "agent:main:subagent:child-1",
      maxAgeMs: 6 * 60 * 60 * 1000,
    });

    expect(idleUpdated).toHaveLength(1);
    expect(idleUpdated[0]?.idleTimeoutMs).toBe(2 * 60 * 60 * 1000);
    expect(maxAgeUpdated).toHaveLength(1);
    expect(maxAgeUpdated[0]?.maxAgeMs).toBe(6 * 60 * 60 * 1000);
    expect(maxAgeUpdated[0]?.boundAt).toBe(original?.boundAt);
    expect(maxAgeUpdated[0]?.lastActivityAt).toBe(Date.parse("2026-03-06T12:00:00.000Z"));
    expect(manager.listBySessionKey("agent:main:subagent:child-1")[0]?.maxAgeMs).toBe(
      6 * 60 * 60 * 1000,
    );
  });

  it("does not persist lifecycle updates when manager persistence is disabled", async () => {
    stateDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDirOverride;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));

    createSlackThreadBindingManager({
      accountId: "no-persist",
      persist: false,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-2",
      targetKind: "subagent",
      conversation: {
        channel: "slack",
        accountId: "no-persist",
        conversationId: "1710000000.000500",
        parentConversationId: "C2222222",
      },
    });

    setSlackThreadBindingIdleTimeoutBySessionKey({
      accountId: "no-persist",
      targetSessionKey: "agent:main:subagent:child-2",
      idleTimeoutMs: 60 * 60 * 1000,
    });
    setSlackThreadBindingMaxAgeBySessionKey({
      accountId: "no-persist",
      targetSessionKey: "agent:main:subagent:child-2",
      maxAgeMs: 2 * 60 * 60 * 1000,
    });

    const statePath = path.join(
      resolveStateDir(process.env, os.homedir),
      "slack",
      "thread-bindings-no-persist.json",
    );
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("persists unbinds before restart so removed bindings do not come back", async () => {
    stateDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDirOverride;

    createSlackThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    const bound = await getSessionBindingService().bind({
      targetSessionKey: "plugin-binding:openclaw-codex-app-server:abc123",
      targetKind: "session",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "1710000000.000600",
        parentConversationId: "C3333333",
      },
    });

    await getSessionBindingService().unbind({
      bindingId: bound.bindingId,
      reason: "test-detach",
    });

    await __testing.resetSlackThreadBindingsForTests();

    const reloaded = createSlackThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    expect(
      reloaded.getByThread({ channelId: "C3333333", threadTs: "1710000000.000600" }),
    ).toBeUndefined();
  });

  it("only removes matching-kind bindings when targetKind is passed to unbindBySessionKey", async () => {
    const manager = createSlackThreadBindingManager({
      accountId: "mixed-kind",
      persist: false,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "shared:mixed-kind:session",
      targetKind: "subagent",
      conversation: {
        channel: "slack",
        accountId: "mixed-kind",
        conversationId: "1710000000.000800",
        parentConversationId: "C5555555",
      },
      placement: "current",
    });
    await getSessionBindingService().bind({
      targetSessionKey: "shared:mixed-kind:session",
      targetKind: "session",
      conversation: {
        channel: "slack",
        accountId: "mixed-kind",
        conversationId: "1710000000.000801",
        parentConversationId: "C5555555",
      },
      placement: "current",
    });

    const removed = unbindSlackThreadBindingsBySessionKey({
      accountId: "mixed-kind",
      targetSessionKey: "shared:mixed-kind:session",
      targetKind: "subagent",
      reason: "test-kind-scoped-unbind",
    });

    expect(removed).toHaveLength(1);
    expect(removed[0]?.targetKind).toBe("subagent");
    expect(removed[0]?.threadTs).toBe("1710000000.000800");

    const remaining = manager.listBySessionKey("shared:mixed-kind:session");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.targetKind).toBe("acp");
    expect(remaining[0]?.threadTs).toBe("1710000000.000801");
    expect(
      manager.getByThread({ channelId: "C5555555", threadTs: "1710000000.000801" }),
    ).toBeDefined();
    expect(
      manager.getByThread({ channelId: "C5555555", threadTs: "1710000000.000800" }),
    ).toBeUndefined();
  });

  it("flushes pending lifecycle update persists before test reset", async () => {
    stateDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDirOverride;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));

    createSlackThreadBindingManager({
      accountId: "persist-reset",
      persist: true,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-3",
      targetKind: "subagent",
      conversation: {
        channel: "slack",
        accountId: "persist-reset",
        conversationId: "1710000000.000700",
        parentConversationId: "C4444444",
      },
    });

    setSlackThreadBindingIdleTimeoutBySessionKey({
      accountId: "persist-reset",
      targetSessionKey: "agent:main:subagent:child-3",
      idleTimeoutMs: 90_000,
    });

    await __testing.resetSlackThreadBindingsForTests();

    const statePath = path.join(
      resolveStateDir(process.env, os.homedir),
      "slack",
      "thread-bindings-persist-reset.json",
    );
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      bindings?: Array<{ idleTimeoutMs?: number }>;
    };
    expect(persisted.bindings?.[0]?.idleTimeoutMs).toBe(90_000);
  });
});
