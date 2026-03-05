import { describe, expect, it } from "vitest";
import { createGenerationTask } from "./codegen-service";

describe("codegen service", () => {
  it("rejects missing description", async () => {
    await expect(
      createGenerationTask({ description: "", type: "web" }),
    ).rejects.toThrow("description");
  });
});
