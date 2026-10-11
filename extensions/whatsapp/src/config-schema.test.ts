import { describe, expect, it } from "vitest";
import { WhatsAppConfigSchema } from "../config-api.js";

describe("whatsapp config schema", () => {
  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    const res = WhatsAppConfigSchema.safeParse({
      dmPolicy: "open",
      allowFrom: ["+15555550123"],
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("allowFrom");
    }
  });
});
