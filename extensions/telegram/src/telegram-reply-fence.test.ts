// Telegram tests cover telegram reply fence plugin behavior.
import { describe, expect, it } from "vitest";
import {
  beginTelegramReplyFence,
  buildTelegramNonInterruptingReplyFenceKey,
  buildTelegramReplyFenceLaneKey,
  endTelegramReplyFence,
  hasActiveTelegramReplyFenceLane,
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

  it("keeps normal group turns from superseding older owed replies while preserving aborts", () => {
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "@bot answer this",
        CommandAuthorized: true,
      }),
    ).toBe(false);
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
  });

  it("lets authorized explicit group commands supersede active reply work", () => {
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/export-trajectory bundle",
        CommandAuthorized: true,
        CommandTurn: {
          kind: "text-slash",
          source: "text",
          authorized: true,
          commandName: "export-trajectory",
          body: "/export-trajectory bundle",
        },
      }),
    ).toBe(true);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/diagnostics confirm abc123def456",
        CommandAuthorized: true,
        CommandTurn: {
          kind: "text-slash",
          source: "text",
          authorized: true,
          commandName: "diagnostics",
          body: "/diagnostics confirm abc123def456",
        },
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

  it("reports active work by Telegram topic lane", () => {
    resetTelegramReplyFenceForTests();
    const activeKey = "agent:main:telegram:group:-100123:topic:99";
    const laneKey = buildTelegramReplyFenceLaneKey({
      accountId: "openclaw",
      sequentialKey: "telegram:-100123:topic:99",
    });
    const childKey = buildTelegramNonInterruptingReplyFenceKey({ activeKey, laneKey });

    expect(hasActiveTelegramReplyFenceLane(laneKey)).toBe(false);
    beginTelegramReplyFence({
      key: childKey,
      supersede: false,
      laneKey,
    });
    expect(hasActiveTelegramReplyFenceLane(laneKey)).toBe(true);

    endTelegramReplyFence(childKey);
    expect(hasActiveTelegramReplyFenceLane(laneKey)).toBe(false);
    resetTelegramReplyFenceForTests();
  });
});
