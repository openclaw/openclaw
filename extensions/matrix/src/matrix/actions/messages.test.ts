/**
 * Regression test: sendMatrixMessage must forward accountId to sendMessageMatrix.
 *
 * Before fix: sendMatrixMessage called sendMessageMatrix without accountId,
 * causing resolveMatrixClient to fall back to getAnyActiveMatrixClient().
 *
 * After fix: opts.accountId is forwarded, so the correct account is used.
 *
 * See: openclaw/openclaw#26457
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted — factory must not reference outer variables
vi.mock("../send.js", () => ({
  resolveMatrixRoomId: vi.fn().mockResolvedValue("!room:matrix.org"),
  sendMessageMatrix: vi.fn().mockResolvedValue({ messageId: "evt1", roomId: "!room" }),
}));

vi.mock("./client.js", () => ({}));

import * as sendModule from "../send.js";
import { sendMatrixMessage } from "./messages.js";

const sendMessageMatrixMock = vi.mocked(sendModule.sendMessageMatrix);

describe("sendMatrixMessage — accountId forwarding", () => {
  beforeEach(() => {
    sendMessageMatrixMock.mockClear();
  });

  it("forwards accountId to sendMessageMatrix when provided", async () => {
    await sendMatrixMessage("!room:matrix.org", "hello", { accountId: "neko" });

    expect(sendMessageMatrixMock).toHaveBeenCalledOnce();
    const opts = sendMessageMatrixMock.mock.calls[0][2];
    expect(opts?.accountId).toBe("neko");
  });

  it("forwards undefined accountId (no regression for single-account setups)", async () => {
    await sendMatrixMessage("!room:matrix.org", "hello", {});

    expect(sendMessageMatrixMock).toHaveBeenCalledOnce();
    const opts = sendMessageMatrixMock.mock.calls[0][2];
    expect(opts?.accountId == null).toBe(true);
  });
});
