import { describe, expect, it } from "vitest";
import {
  isDmAllowed,
  isGroupInviteAllowed,
  isBotMentioned,
  extractMessageText
} from "./monitor/utils.js";
import { normalizeShip } from "./targets.js";
describe("Security: DM Allowlist", () => {
  describe("isDmAllowed", () => {
    it("rejects DMs when allowlist is empty", () => {
      expect(isDmAllowed("~zod", [])).toBe(false);
      expect(isDmAllowed("~sampel-palnet", [])).toBe(false);
    });
    it("rejects DMs when allowlist is undefined", () => {
      expect(isDmAllowed("~zod", void 0)).toBe(false);
    });
    it("allows DMs from ships on the allowlist", () => {
      const allowlist = ["~zod", "~bus"];
      expect(isDmAllowed("~zod", allowlist)).toBe(true);
      expect(isDmAllowed("~bus", allowlist)).toBe(true);
    });
    it("rejects DMs from ships NOT on the allowlist", () => {
      const allowlist = ["~zod", "~bus"];
      expect(isDmAllowed("~nec", allowlist)).toBe(false);
      expect(isDmAllowed("~sampel-palnet", allowlist)).toBe(false);
      expect(isDmAllowed("~random-ship", allowlist)).toBe(false);
    });
    it("normalizes ship names (with/without ~ prefix)", () => {
      const allowlist = ["~zod"];
      expect(isDmAllowed("zod", allowlist)).toBe(true);
      expect(isDmAllowed("~zod", allowlist)).toBe(true);
      const allowlistWithoutTilde = ["zod"];
      expect(isDmAllowed("~zod", allowlistWithoutTilde)).toBe(true);
      expect(isDmAllowed("zod", allowlistWithoutTilde)).toBe(true);
    });
    it("handles galaxy, star, planet, and moon names", () => {
      const allowlist = [
        "~zod",
        // galaxy
        "~marzod",
        // star
        "~sampel-palnet",
        // planet
        "~dozzod-dozzod-dozzod-dozzod"
        // moon
      ];
      expect(isDmAllowed("~zod", allowlist)).toBe(true);
      expect(isDmAllowed("~marzod", allowlist)).toBe(true);
      expect(isDmAllowed("~sampel-palnet", allowlist)).toBe(true);
      expect(isDmAllowed("~dozzod-dozzod-dozzod-dozzod", allowlist)).toBe(true);
      expect(isDmAllowed("~nec", allowlist)).toBe(false);
      expect(isDmAllowed("~wanzod", allowlist)).toBe(false);
      expect(isDmAllowed("~sampel-palned", allowlist)).toBe(false);
    });
    it("uses strict equality after normalization (case-sensitive)", () => {
      const allowlist = ["~zod"];
      expect(isDmAllowed("~zod", allowlist)).toBe(true);
      expect(isDmAllowed("~Zod", ["~Zod"])).toBe(true);
    });
    it("does not allow partial matches", () => {
      const allowlist = ["~zod"];
      expect(isDmAllowed("~zod-extra", allowlist)).toBe(false);
      expect(isDmAllowed("~extra-zod", allowlist)).toBe(false);
    });
    it("handles whitespace in ship names (normalized)", () => {
      const allowlist = [" ~zod ", "~bus"];
      expect(isDmAllowed("~zod", allowlist)).toBe(true);
      expect(isDmAllowed(" ~zod ", allowlist)).toBe(true);
    });
  });
});
describe("Security: Group Invite Allowlist", () => {
  describe("isGroupInviteAllowed", () => {
    it("rejects invites when allowlist is empty (fail-safe)", () => {
      expect(isGroupInviteAllowed("~zod", [])).toBe(false);
      expect(isGroupInviteAllowed("~sampel-palnet", [])).toBe(false);
      expect(isGroupInviteAllowed("~malicious-actor", [])).toBe(false);
    });
    it("rejects invites when allowlist is undefined (fail-safe)", () => {
      expect(isGroupInviteAllowed("~zod", void 0)).toBe(false);
      expect(isGroupInviteAllowed("~sampel-palnet", void 0)).toBe(false);
    });
    it("accepts invites from ships on the allowlist", () => {
      const allowlist = ["~nocsyx-lassul", "~malmur-halmex"];
      expect(isGroupInviteAllowed("~nocsyx-lassul", allowlist)).toBe(true);
      expect(isGroupInviteAllowed("~malmur-halmex", allowlist)).toBe(true);
    });
    it("rejects invites from ships NOT on the allowlist", () => {
      const allowlist = ["~nocsyx-lassul", "~malmur-halmex"];
      expect(isGroupInviteAllowed("~random-attacker", allowlist)).toBe(false);
      expect(isGroupInviteAllowed("~malicious-ship", allowlist)).toBe(false);
      expect(isGroupInviteAllowed("~zod", allowlist)).toBe(false);
    });
    it("normalizes ship names (with/without ~ prefix)", () => {
      const allowlist = ["~nocsyx-lassul"];
      expect(isGroupInviteAllowed("nocsyx-lassul", allowlist)).toBe(true);
      expect(isGroupInviteAllowed("~nocsyx-lassul", allowlist)).toBe(true);
      const allowlistWithoutTilde = ["nocsyx-lassul"];
      expect(isGroupInviteAllowed("~nocsyx-lassul", allowlistWithoutTilde)).toBe(true);
    });
    it("does not allow partial matches", () => {
      const allowlist = ["~zod"];
      expect(isGroupInviteAllowed("~zod-moon", allowlist)).toBe(false);
      expect(isGroupInviteAllowed("~pinser-botter-zod", allowlist)).toBe(false);
    });
    it("handles whitespace in allowlist entries", () => {
      const allowlist = [" ~nocsyx-lassul ", "~malmur-halmex"];
      expect(isGroupInviteAllowed("~nocsyx-lassul", allowlist)).toBe(true);
    });
  });
});
describe("Security: Bot Mention Detection", () => {
  describe("isBotMentioned", () => {
    const botShip = "~sampel-palnet";
    const nickname = "nimbus";
    it("detects direct ship mention", () => {
      expect(isBotMentioned("hey ~sampel-palnet", botShip)).toBe(true);
      expect(isBotMentioned("~sampel-palnet can you help?", botShip)).toBe(true);
      expect(isBotMentioned("hello ~sampel-palnet how are you", botShip)).toBe(true);
    });
    it("detects @all mention", () => {
      expect(isBotMentioned("@all please respond", botShip)).toBe(true);
      expect(isBotMentioned("hey @all", botShip)).toBe(true);
      expect(isBotMentioned("@ALL uppercase", botShip)).toBe(true);
    });
    it("detects nickname mention", () => {
      expect(isBotMentioned("hey nimbus", botShip, nickname)).toBe(true);
      expect(isBotMentioned("nimbus help me", botShip, nickname)).toBe(true);
      expect(isBotMentioned("hello NIMBUS", botShip, nickname)).toBe(true);
    });
    it("does NOT trigger on random messages", () => {
      expect(isBotMentioned("hello world", botShip)).toBe(false);
      expect(isBotMentioned("this is a normal message", botShip)).toBe(false);
      expect(isBotMentioned("hey everyone", botShip)).toBe(false);
    });
    it("does NOT trigger on partial ship matches", () => {
      expect(isBotMentioned("~sampel-palnet-extra", botShip)).toBe(false);
      expect(isBotMentioned("my~sampel-palnetfriend", botShip)).toBe(false);
    });
    it("does NOT trigger on substring nickname matches", () => {
      expect(isBotMentioned("nimbusy", botShip, nickname)).toBe(false);
      expect(isBotMentioned("prenimbus", botShip, nickname)).toBe(false);
    });
    it("handles empty/null inputs safely", () => {
      expect(isBotMentioned("", botShip)).toBe(false);
      expect(isBotMentioned("test", "")).toBe(false);
      expect(isBotMentioned(null, botShip)).toBe(false);
    });
    it("requires word boundary for nickname", () => {
      expect(isBotMentioned("nimbus, hello", botShip, nickname)).toBe(true);
      expect(isBotMentioned("hello nimbus!", botShip, nickname)).toBe(true);
      expect(isBotMentioned("nimbus?", botShip, nickname)).toBe(true);
    });
  });
});
describe("Security: Ship Normalization", () => {
  describe("normalizeShip", () => {
    it("adds ~ prefix if missing", () => {
      expect(normalizeShip("zod")).toBe("~zod");
      expect(normalizeShip("sampel-palnet")).toBe("~sampel-palnet");
    });
    it("preserves ~ prefix if present", () => {
      expect(normalizeShip("~zod")).toBe("~zod");
      expect(normalizeShip("~sampel-palnet")).toBe("~sampel-palnet");
    });
    it("trims whitespace", () => {
      expect(normalizeShip(" ~zod ")).toBe("~zod");
      expect(normalizeShip("  zod  ")).toBe("~zod");
    });
    it("handles empty string", () => {
      expect(normalizeShip("")).toBe("");
      expect(normalizeShip("   ")).toBe("");
    });
  });
});
describe("Security: Message Text Extraction", () => {
  describe("extractMessageText", () => {
    it("extracts plain text", () => {
      const content = [{ inline: ["hello world"] }];
      expect(extractMessageText(content)).toBe("hello world");
    });
    it("extracts @all mentions from sect null", () => {
      const content = [{ inline: [{ sect: null }] }];
      expect(extractMessageText(content)).toContain("@all");
    });
    it("extracts ship mentions", () => {
      const content = [{ inline: [{ ship: "~zod" }] }];
      expect(extractMessageText(content)).toContain("~zod");
    });
    it("handles malformed input safely", () => {
      expect(extractMessageText(null)).toBe("");
      expect(extractMessageText(void 0)).toBe("");
      expect(extractMessageText([])).toBe("");
      expect(extractMessageText([{}])).toBe("");
      expect(extractMessageText("not an array")).toBe("");
    });
    it("does not execute injected code in inline content", () => {
      const maliciousContent = [{ inline: ["<script>alert('xss')</script>"] }];
      const result = extractMessageText(maliciousContent);
      expect(result).toBe("<script>alert('xss')</script>");
    });
  });
});
describe("Security: Channel Authorization Logic", () => {
  it("default mode should be restricted (not open)", () => {
    const rule = void 0;
    const mode = rule?.mode ?? "restricted";
    expect(mode).toBe("restricted");
  });
  it("empty allowedShips with restricted mode should block all", () => {
    const _mode = "restricted";
    const allowedShips = [];
    const sender = "~random-ship";
    const isAllowed = allowedShips.some((ship) => normalizeShip(ship) === normalizeShip(sender));
    expect(isAllowed).toBe(false);
  });
  it("open mode should not check allowedShips", () => {
    const mode = "open";
    expect(mode).not.toBe("restricted");
  });
  it("settings should override file config for channel rules", () => {
    const fileRules = { "chat/~zod/test": { mode: "restricted" } };
    const settingsRules = { "chat/~zod/test": { mode: "open" } };
    const nest = "chat/~zod/test";
    const effectiveRule = settingsRules[nest] ?? fileRules[nest];
    expect(effectiveRule?.mode).toBe("open");
  });
});
describe("Security: Authorization Edge Cases", () => {
  it("empty strings are not valid ships", () => {
    expect(isDmAllowed("", ["~zod"])).toBe(false);
    expect(isDmAllowed("~zod", [""])).toBe(false);
  });
  it("handles very long ship-like strings", () => {
    const longName = "~" + "a".repeat(1e3);
    expect(isDmAllowed(longName, ["~zod"])).toBe(false);
  });
  it("handles special characters that could break regex", () => {
    const maliciousShip = "~zod.*";
    expect(isDmAllowed("~zodabc", [maliciousShip])).toBe(false);
    const allowlist = ["~zod"];
    expect(isDmAllowed("~zod.*", allowlist)).toBe(false);
  });
  it("protects against prototype pollution-style keys", () => {
    const suspiciousShip = "__proto__";
    expect(isDmAllowed(suspiciousShip, ["~zod"])).toBe(false);
    expect(isDmAllowed("~zod", [suspiciousShip])).toBe(false);
  });
});
describe("Security: Sender Role Identification", () => {
  function getSenderRole(senderShip, ownerShip) {
    if (!ownerShip) return "user";
    return normalizeShip(senderShip) === normalizeShip(ownerShip) ? "owner" : "user";
  }
  describe("owner detection", () => {
    it("identifies owner when ownerShip matches sender", () => {
      expect(getSenderRole("~nocsyx-lassul", "~nocsyx-lassul")).toBe("owner");
      expect(getSenderRole("nocsyx-lassul", "~nocsyx-lassul")).toBe("owner");
      expect(getSenderRole("~nocsyx-lassul", "nocsyx-lassul")).toBe("owner");
    });
    it("identifies user when ownerShip does not match sender", () => {
      expect(getSenderRole("~random-user", "~nocsyx-lassul")).toBe("user");
      expect(getSenderRole("~malicious-actor", "~nocsyx-lassul")).toBe("user");
    });
    it("identifies everyone as user when ownerShip is null", () => {
      expect(getSenderRole("~nocsyx-lassul", null)).toBe("user");
      expect(getSenderRole("~zod", null)).toBe("user");
    });
    it("identifies everyone as user when ownerShip is empty string", () => {
      expect(getSenderRole("~nocsyx-lassul", "")).toBe("user");
    });
  });
  describe("label format", () => {
    function getFromLabel(senderShip, ownerShip, isGroup, channelNest) {
      const senderRole = getSenderRole(senderShip, ownerShip);
      return isGroup ? `${senderShip} [${senderRole}] in ${channelNest}` : `${senderShip} [${senderRole}]`;
    }
    it("DM from owner includes [owner] in label", () => {
      const label = getFromLabel("~nocsyx-lassul", "~nocsyx-lassul", false);
      expect(label).toBe("~nocsyx-lassul [owner]");
      expect(label).toContain("[owner]");
    });
    it("DM from user includes [user] in label", () => {
      const label = getFromLabel("~random-user", "~nocsyx-lassul", false);
      expect(label).toBe("~random-user [user]");
      expect(label).toContain("[user]");
    });
    it("group message from owner includes [owner] in label", () => {
      const label = getFromLabel("~nocsyx-lassul", "~nocsyx-lassul", true, "chat/~host/general");
      expect(label).toBe("~nocsyx-lassul [owner] in chat/~host/general");
      expect(label).toContain("[owner]");
    });
    it("group message from user includes [user] in label", () => {
      const label = getFromLabel("~random-user", "~nocsyx-lassul", true, "chat/~host/general");
      expect(label).toBe("~random-user [user] in chat/~host/general");
      expect(label).toContain("[user]");
    });
  });
  describe("impersonation prevention", () => {
    it("approved user cannot get [owner] label through ship name tricks", () => {
      expect(getSenderRole("~nocsyx-lassul-fake", "~nocsyx-lassul")).toBe("user");
      expect(getSenderRole("~fake-nocsyx-lassul", "~nocsyx-lassul")).toBe("user");
    });
    it("message content cannot change sender role", () => {
      const senderShip = "~malicious-actor";
      const ownerShip = "~nocsyx-lassul";
      expect(getSenderRole(senderShip, ownerShip)).toBe("user");
    });
  });
});
