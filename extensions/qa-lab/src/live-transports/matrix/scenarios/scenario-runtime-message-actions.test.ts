import { describe, expect, it } from "vitest";
import { requireMatrixPublicSendEventId } from "./scenario-runtime-message-actions.js";

const roomId = "!actions:matrix-qa.test";
const receipt = {
  channel: "matrix",
  deliveryStatus: "sent",
  result: { messageId: "$accepted", target: { kind: "room", id: roomId } },
};

describe("Matrix public send receipt", () => {
  it("requires Gateway-owned proof of a send to the scenario room", () => {
    expect(requireMatrixPublicSendEventId(receipt, roomId)).toBe("$accepted");
  });

  it.each(["suppressed", "failed", "partial_failed", undefined])(
    "rejects delivery status %s even with a nested event id",
    (deliveryStatus) => {
      expect(() => requireMatrixPublicSendEventId({ ...receipt, deliveryStatus }, roomId)).toThrow(
        "Matrix send must succeed",
      );
    },
  );

  it("rejects a receipt for the wrong room or without a Matrix event id", () => {
    expect(() => requireMatrixPublicSendEventId(receipt, "!other:matrix-qa.test")).toThrow(
      "Matrix send must identify the requested room",
    );
    expect(() =>
      requireMatrixPublicSendEventId(
        { ...receipt, result: { ...receipt.result, messageId: "not-a-matrix-id" } },
        roomId,
      ),
    ).toThrow("Matrix send needs an event id");
  });
});
