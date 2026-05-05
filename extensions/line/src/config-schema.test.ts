import { describe, expect, it } from "vitest";
import { LineConfigSchema } from "./config-schema.js";

describe("line config schema", () => {
  it("preserves streaming preview toolProgress without streaming mode", () => {
    const result = LineConfigSchema.safeParse({
      streaming: { preview: { toolProgress: false } },
      accounts: {
        work: {
          streaming: { preview: { toolProgress: false } },
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.streaming?.preview?.toolProgress).toBe(false);
      expect(result.data.streaming?.mode).toBeUndefined();
      expect(result.data.accounts?.work?.streaming?.preview?.toolProgress).toBe(false);
      expect(result.data.accounts?.work?.streaming?.mode).toBeUndefined();
    }
  });
});
