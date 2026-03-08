import { describe, expect, it } from "vitest";
import { resolveMatrixRoutePeer, type MatrixSessionScope } from "./handler.js";

describe("resolveMatrixRoutePeer", () => {
  const roomId = "!room:example.org";
  const senderId = "@alice:example.org";

  it("sessionScope=room always routes by roomId", () => {
    const sessionScope: MatrixSessionScope = "room";

    expect(
      resolveMatrixRoutePeer({
        sessionScope,
        isDirectMessage: true,
        senderId,
        roomId,
      }),
    ).toEqual({ kind: "channel", id: roomId });

    expect(
      resolveMatrixRoutePeer({
        sessionScope,
        isDirectMessage: false,
        senderId,
        roomId,
      }),
    ).toEqual({ kind: "channel", id: roomId });
  });

  it("sessionScope=legacy routes DMs by senderId and rooms by roomId", () => {
    const sessionScope: MatrixSessionScope = "legacy";

    expect(
      resolveMatrixRoutePeer({
        sessionScope,
        isDirectMessage: true,
        senderId,
        roomId,
      }),
    ).toEqual({ kind: "direct", id: senderId });

    expect(
      resolveMatrixRoutePeer({
        sessionScope,
        isDirectMessage: false,
        senderId,
        roomId,
      }),
    ).toEqual({ kind: "channel", id: roomId });
  });
});
