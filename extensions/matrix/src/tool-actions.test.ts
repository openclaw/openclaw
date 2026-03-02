import { beforeEach, describe, expect, it, vi } from "vitest";
/**
 * Regression tests: handleMatrixAction must extract accountId from tool params
 * and forward it to every action handler, so isolated sessions (cron/subagent)
 * always use the correct Matrix account.
 *
 * Before fix: only sendMessage forwarded accountId; all other actions silently
 * routed to DEFAULT_ACCOUNT_ID regardless of which agent called the tool.
 *
 * See: openclaw/openclaw#26457
 */
import type { CoreConfig } from "./types.js";

// vi.mock is hoisted — factories must not reference outer variables
vi.mock("./matrix/actions.js", () => ({
  sendMatrixMessage: vi.fn().mockResolvedValue({ messageId: "evt1", roomId: "!room:matrix.org" }),
  editMatrixMessage: vi.fn().mockResolvedValue({ eventId: "evt1" }),
  deleteMatrixMessage: vi.fn().mockResolvedValue(undefined),
  readMatrixMessages: vi.fn().mockResolvedValue({ messages: [], nextBatch: null, prevBatch: null }),
  listMatrixPins: vi.fn().mockResolvedValue({ pinned: [], events: [] }),
  pinMatrixMessage: vi.fn().mockResolvedValue({ pinned: ["$evt1"] }),
  unpinMatrixMessage: vi.fn().mockResolvedValue({ pinned: [] }),
  listMatrixReactions: vi.fn().mockResolvedValue([]),
  removeMatrixReactions: vi.fn().mockResolvedValue({ removed: 0 }),
  getMatrixMemberInfo: vi.fn().mockResolvedValue({}),
  getMatrixRoomInfo: vi.fn().mockResolvedValue({}),
}));

vi.mock("./matrix/send.js", () => ({
  reactMatrixMessage: vi.fn().mockResolvedValue(undefined),
}));

import * as actionsModule from "./matrix/actions.js";
import * as sendModule from "./matrix/send.js";
import { handleMatrixAction } from "./tool-actions.js";

// Pass empty CoreConfig — createActionGate(undefined) enables all actions by default
const cfg = {} as CoreConfig;

const editMock = vi.mocked(actionsModule.editMatrixMessage);
const deleteMock = vi.mocked(actionsModule.deleteMatrixMessage);
const readMock = vi.mocked(actionsModule.readMatrixMessages);
const listReactionsMock = vi.mocked(actionsModule.listMatrixReactions);
const removeReactionsMock = vi.mocked(actionsModule.removeMatrixReactions);
const pinMock = vi.mocked(actionsModule.pinMatrixMessage);
const unpinMock = vi.mocked(actionsModule.unpinMatrixMessage);
const listPinsMock = vi.mocked(actionsModule.listMatrixPins);
const reactMock = vi.mocked(sendModule.reactMatrixMessage);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleMatrixAction — accountId forwarding for all actions", () => {
  it("editMessage forwards accountId from params", async () => {
    await handleMatrixAction(
      {
        action: "editMessage",
        roomId: "!room:matrix.org",
        messageId: "$evt1",
        content: "updated text",
        accountId: "neko",
      },
      cfg,
    );

    expect(editMock).toHaveBeenCalledOnce();
    // editMatrixMessage(roomId, messageId, content, opts) — opts is index 3
    expect(editMock.mock.calls[0][3]).toMatchObject({ accountId: "neko" });
  });

  it("deleteMessage forwards accountId from params", async () => {
    await handleMatrixAction(
      {
        action: "deleteMessage",
        roomId: "!room:matrix.org",
        messageId: "$evt1",
        accountId: "neko",
      },
      cfg,
    );

    expect(deleteMock).toHaveBeenCalledOnce();
    // deleteMatrixMessage(roomId, messageId, opts) — opts is index 2
    expect(deleteMock.mock.calls[0][2]).toMatchObject({ accountId: "neko" });
  });

  it("readMessages forwards accountId from params", async () => {
    await handleMatrixAction(
      {
        action: "readMessages",
        roomId: "!room:matrix.org",
        accountId: "neko",
      },
      cfg,
    );

    expect(readMock).toHaveBeenCalledOnce();
    // readMatrixMessages(roomId, opts) — opts is index 1
    expect(readMock.mock.calls[0][1]).toMatchObject({ accountId: "neko" });
  });

  it("react (add emoji) forwards accountId to reactMatrixMessage", async () => {
    await handleMatrixAction(
      {
        action: "react",
        to: "!room:matrix.org",
        messageId: "$evt1",
        emoji: "👍",
        accountId: "neko",
      },
      cfg,
    );

    expect(reactMock).toHaveBeenCalledOnce();
    // reactMatrixMessage(roomId, messageId, emoji, opts) — opts is index 3
    expect(reactMock.mock.calls[0][3]).toMatchObject({ accountId: "neko" });
  });

  it("react (remove emoji) forwards accountId to removeMatrixReactions", async () => {
    await handleMatrixAction(
      {
        action: "react",
        to: "!room:matrix.org",
        messageId: "$evt1",
        emoji: "👍",
        remove: true,
        accountId: "neko",
      },
      cfg,
    );

    expect(removeReactionsMock).toHaveBeenCalledOnce();
    // removeMatrixReactions(roomId, messageId, opts) — opts is index 2
    expect(removeReactionsMock.mock.calls[0][2]).toMatchObject({ accountId: "neko" });
  });

  it("reactions forwards accountId to listMatrixReactions", async () => {
    await handleMatrixAction(
      {
        action: "reactions",
        to: "!room:matrix.org",
        messageId: "$evt1",
        accountId: "neko",
      },
      cfg,
    );

    expect(listReactionsMock).toHaveBeenCalledOnce();
    // listMatrixReactions(roomId, messageId, opts) — opts is index 2
    expect(listReactionsMock.mock.calls[0][2]).toMatchObject({ accountId: "neko" });
  });

  it("pinMessage forwards accountId from params", async () => {
    await handleMatrixAction(
      {
        action: "pinMessage",
        roomId: "!room:matrix.org",
        messageId: "$evt1",
        accountId: "neko",
      },
      cfg,
    );

    expect(pinMock).toHaveBeenCalledOnce();
    // pinMatrixMessage(roomId, messageId, opts) — opts is index 2
    expect(pinMock.mock.calls[0][2]).toMatchObject({ accountId: "neko" });
  });

  it("unpinMessage forwards accountId from params", async () => {
    await handleMatrixAction(
      {
        action: "unpinMessage",
        roomId: "!room:matrix.org",
        messageId: "$evt1",
        accountId: "neko",
      },
      cfg,
    );

    expect(unpinMock).toHaveBeenCalledOnce();
    // unpinMatrixMessage(roomId, messageId, opts) — opts is index 2
    expect(unpinMock.mock.calls[0][2]).toMatchObject({ accountId: "neko" });
  });

  it("listPins forwards accountId from params", async () => {
    await handleMatrixAction(
      {
        action: "listPins",
        roomId: "!room:matrix.org",
        accountId: "neko",
      },
      cfg,
    );

    expect(listPinsMock).toHaveBeenCalledOnce();
    // listMatrixPins(roomId, opts) — opts is index 1
    expect(listPinsMock.mock.calls[0][1]).toMatchObject({ accountId: "neko" });
  });
});
