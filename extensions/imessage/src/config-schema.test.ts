// Imessage tests cover config schema plugin behavior.
import { describe, expect, it } from "vitest";
import { IMessageConfigSchema } from "../config-api.js";

describe("imessage config schema", () => {
  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    const res = IMessageConfigSchema.safeParse({
      dmPolicy: "open",
      allowFrom: ["+15555550123"],
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("allowFrom");
    }
  });

  it("accepts optional bot-thread mention overrides in root and account group maps", () => {
    const result = IMessageConfigSchema.parse({
      groups: { "*": { requireMention: true, requireMentionInBotThreads: false } },
      accounts: {
        work: { groups: { "123": { requireMentionInBotThreads: true } } },
      },
    });
    expect(result.groups?.["*"]?.requireMentionInBotThreads).toBe(false);
    expect(result.dmPolicy).toBe("pairing");
    expect(result.groupPolicy).toBe("allowlist");
    expect(result.accounts?.work?.groups?.["123"]?.requireMentionInBotThreads).toBe(true);
    expect(IMessageConfigSchema.parse({ groups: { "*": {} } }).groups?.["*"]).not.toHaveProperty(
      "requireMentionInBotThreads",
    );
  });

  it("rejects unsafe executable config values", () => {
    const res = IMessageConfigSchema.safeParse({ cliPath: "imsg; rm -rf /" });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("cliPath");
    }
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
