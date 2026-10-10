import { describe, expect, it } from "vitest";
import {
  isMatrixVerificationEventType,
  isMatrixVerificationRoomMessage,
} from "./verification-utils.js";

describe("matrix verification message classifiers", () => {
  it("recognizes verification event types", () => {
    expect(isMatrixVerificationEventType("m.key.verification.start")).toBe(true);
    expect(isMatrixVerificationEventType("m.room.message")).toBe(false);
  });

  it("recognizes verification notice bodies", () => {
    expect(
      isMatrixVerificationRoomMessage({
        msgtype: "m.notice",
        body: "Matrix verification started with @alice:example.org.",
      }),
    ).toBe(true);
    expect(isMatrixVerificationRoomMessage({ msgtype: "m.notice", body: "hello world" })).toBe(
      false,
    );
  });

  it("classifies verification room messages", () => {
    expect(
      isMatrixVerificationRoomMessage({
        msgtype: "m.key.verification.request",
        body: "verify request",
      }),
    ).toBe(true);
    expect(
      isMatrixVerificationRoomMessage({
        msgtype: "m.notice",
        body: "Matrix verification cancelled by @alice:example.org.",
      }),
    ).toBe(true);
    expect(
      isMatrixVerificationRoomMessage({
        msgtype: "m.text",
        body: "normal chat message",
      }),
    ).toBe(false);
  });
});
