import { describe, expect, it } from "vitest";
import { BlueBubblesConfigSchema } from "./config-schema.js";

const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });

describe("bluebubbles SecretRef config schema", () => {
  it("accepts SecretRefs for handle allowlists", () => {
    const res = BlueBubblesConfigSchema.safeParse({
      allowFrom: [envRef("BLUEBUBBLES_OWNER")],
      groupAllowFrom: ["${BLUEBUBBLES_GROUP_OWNER}"],
      accounts: {
        work: {
          allowFrom: ["user@example.com", envRef("BLUEBUBBLES_WORK_OWNER")],
          groupAllowFrom: [envRef("BLUEBUBBLES_WORK_GROUP_OWNER")],
        },
      },
    });

    expect(res.success).toBe(true);
  });
});
