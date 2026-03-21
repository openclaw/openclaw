import { describe, expect, it } from "vitest";
import { parseCampfirePayload } from "./payload.js";

describe("parseCampfirePayload", () => {
  const validPayload = {
    user: { id: 42, name: "Alice" },
    room: {
      id: 7,
      name: "General",
      path: "https://campfire.example.com/rooms/7/42-AbCdEf/messages",
    },
    message: {
      id: 99,
      body: {
        html: "<p>Hey @Bot help me</p>",
        plain: "Hey help me",
      },
      path: "https://campfire.example.com/rooms/7/@99",
    },
  };

  it("returns typed payload for valid input", () => {
    const parsed = parseCampfirePayload(validPayload);

    expect(parsed).toEqual(validPayload);
  });

  it("returns null when required fields are missing", () => {
    const parsed = parseCampfirePayload({
      user: { id: 42, name: "Alice" },
      room: { id: 7, name: "General" },
      message: { id: 99, body: { plain: "Hey" } },
    });

    expect(parsed).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(parseCampfirePayload(null)).toBeNull();
    expect(parseCampfirePayload("not-json")).toBeNull();
    expect(parseCampfirePayload(123)).toBeNull();
  });
});
