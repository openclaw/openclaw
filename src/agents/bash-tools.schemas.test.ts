import { describe, expect, it } from "vitest";
import { execSchema } from "./bash-tools.schemas.js";

describe("exec tool schema", () => {
  it("does not expose operator-only policy fields to the model", () => {
    const properties = (execSchema as { properties?: Record<string, unknown> }).properties ?? {};

    expect(properties).toHaveProperty("command");
    for (const field of ["security", "ask", "host", "elevated", "node"]) {
      expect(properties).not.toHaveProperty(field);
    }
  });
});
