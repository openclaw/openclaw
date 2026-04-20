import { describe, expect, it } from "vitest";
import { IMessageConfigSchema } from "../config-api.js";

describe("imessage config schema", () => {
  it("accepts safe remoteHost", () => {
    const res = IMessageConfigSchema.safeParse({
      remoteHost: "bot@gateway-host",
    });

    expect(res.success).toBe(true);
  });

  it("rejects unsafe remoteHost", () => {
    const res = IMessageConfigSchema.safeParse({
      remoteHost: "bot@gateway-host -oProxyCommand=whoami",
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("remoteHost");
    }
  });

  it("accepts attachment root patterns", () => {
    const res = IMessageConfigSchema.safeParse({
      attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      remoteAttachmentRoots: ["/Volumes/relay/attachments"],
    });

    expect(res.success).toBe(true);
  });

  it("rejects relative attachment roots", () => {
    const res = IMessageConfigSchema.safeParse({
      attachmentRoots: ["./attachments"],
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("attachmentRoots.0");
    }
  });
});
