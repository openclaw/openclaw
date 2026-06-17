import { describe, expect, it } from "vitest";
import { extractUserId } from "./agent-id.js";

describe("extractUserId", () => {
  it("extracts the uid from a rabbitmq-<uid> agent id", () => {
    expect(extractUserId("rabbitmq-1749")).toBe("1749");
    expect(extractUserId("rabbitmq-962")).toBe("962");
  });

  it("returns null for non chat agents", () => {
    expect(extractUserId("coding")).toBeNull();
    expect(extractUserId(undefined)).toBeNull();
    expect(extractUserId("")).toBeNull();
    expect(extractUserId("rabbitmq-")).toBeNull();
  });
});
