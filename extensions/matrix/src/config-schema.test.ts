import { describe, expect, it } from "vitest";
import { MatrixConfigSchema } from "./config-schema.js";

describe("MatrixConfigSchema.sessionScope", () => {
  it("accepts room and agent", () => {
    expect(MatrixConfigSchema.parse({ sessionScope: "room" }).sessionScope).toBe("room");
    expect(MatrixConfigSchema.parse({ sessionScope: "agent" }).sessionScope).toBe("agent");
  });

  it("rejects unsupported values", () => {
    expect(() => MatrixConfigSchema.parse({ sessionScope: "global" })).toThrow();
  });
});
