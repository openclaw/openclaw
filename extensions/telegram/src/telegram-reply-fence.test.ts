import { describe, expect, it } from "vitest";
import {
  beginTelegramReplyFence,
  buildTelegramNonInterruptingReplyFenceKey,
  protectTelegramReplyFenceAbortControllerFromNormalSupersede,
  resetTelegramReplyFenceForTests,
  shouldSupersedeTelegramReplyFence,
  supersedeTelegramReplyFence,
} from "./telegram-reply-fence.js";

describe("shouldSupersedeTelegramReplyFence", () => {
  it("keeps non-interrupting side and status commands from superseding active runs", () => {
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/btw what changed?",
        CommandAuthorized: true,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/status",
        CommandAuthorized: true,
      }),
    ).toBe(false);
  });

  it("keeps normal turns and authorized aborts interrupting active runs", () => {
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "@bot answer this",
        CommandAuthorized: true,
      }),
    ).toBe(true);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/stop",
        CommandAuthorized: true,
      }),
    ).toBe(true);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/stop",
        CommandAuthorized: false,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/export-trajectory bundle",
        CommandAuthorized: true,
      }),
    ).toBe(true);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/diagnostics confirm abc123def456",
        CommandAuthorized: true,
      }),
    ).toBe(true);
  });

  it("keeps normal direct turns deliverable while preserving direct aborts", () => {
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "direct",
        CommandBody: "answer this",
        CommandAuthorized: true,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "direct",
        CommandBody: "/stop",
        CommandAuthorized: true,
      }),
    ).toBe(true);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "direct",
        CommandBody: "/diagnostics confirm abc123def456",
        CommandAuthorized: true,
      }),
    ).toBe(true);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "direct",
        CommandBody: "/diagnostics confirm abc123def456",
        CommandAuthorized: false,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "direct",
        CommandBody: "/var/log error",
        CommandAuthorized: true,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "direct",
        CommandBody: "/plugin_command",
        CommandAuthorized: true,
        CommandTurn: {
          kind: "text-slash",
          source: "text",
          authorized: true,
          commandName: "plugin_command",
          body: "/plugin_command",
        },
      }),
    ).toBe(true);
  });
});

describe("telegram reply fence supersede", () => {
  it("cascades base supersedes to non-interrupting child fences", () => {
    resetTelegramReplyFenceForTests();
    const activeKey = "agent:main:telegram:group:-100123";
    const sideController = new AbortController();
    const mainController = new AbortController();
    beginTelegramReplyFence({
      key: activeKey,
      supersede: true,
      abortController: mainController,
    });
    beginTelegramReplyFence({
      key: buildTelegramNonInterruptingReplyFenceKey({
        activeKey,
        laneKey: "default\0telegram:-100123:btw:100",
      }),
      supersede: false,
      abortController: sideController,
    });

    expect(supersedeTelegramReplyFence(activeKey)).toBe(true);
    expect(mainController.signal.aborted).toBe(true);
    expect(sideController.signal.aborted).toBe(true);
    resetTelegramReplyFenceForTests();
  });

  it("protects deferred controllers from normal supersede but not explicit aborts", () => {
    resetTelegramReplyFenceForTests();
    const activeKey = "agent:main:telegram:direct:123";
    const deferredController = new AbortController();
    const nextController = new AbortController();
    beginTelegramReplyFence({
      key: activeKey,
      supersede: true,
      abortController: deferredController,
    });
    protectTelegramReplyFenceAbortControllerFromNormalSupersede(activeKey, deferredController);

    beginTelegramReplyFence({
      key: activeKey,
      supersede: true,
      supersedeMode: "normal",
      abortController: nextController,
    });

    expect(deferredController.signal.aborted).toBe(false);
    expect(nextController.signal.aborted).toBe(false);

    expect(supersedeTelegramReplyFence(activeKey)).toBe(true);
    expect(deferredController.signal.aborted).toBe(true);
    expect(nextController.signal.aborted).toBe(true);
    resetTelegramReplyFenceForTests();
  });

  it("protects deferred child controllers from normal base supersede", () => {
    resetTelegramReplyFenceForTests();
    const activeKey = "agent:main:telegram:group:-100123";
    const childKey = buildTelegramNonInterruptingReplyFenceKey({
      activeKey,
      laneKey: "default\0telegram:-100123:btw:100",
    });
    const deferredController = new AbortController();
    const nextController = new AbortController();
    beginTelegramReplyFence({
      key: childKey,
      supersede: false,
      abortController: deferredController,
    });
    protectTelegramReplyFenceAbortControllerFromNormalSupersede(childKey, deferredController);

    beginTelegramReplyFence({
      key: activeKey,
      supersede: true,
      supersedeMode: "normal",
      abortController: nextController,
    });

    expect(deferredController.signal.aborted).toBe(false);
    expect(nextController.signal.aborted).toBe(false);

    expect(supersedeTelegramReplyFence(activeKey)).toBe(true);
    expect(deferredController.signal.aborted).toBe(true);
    expect(nextController.signal.aborted).toBe(true);
    resetTelegramReplyFenceForTests();
  });
});
