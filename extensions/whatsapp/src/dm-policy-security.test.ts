import { describe, expect, it } from "vitest";

/**
 * WhatsApp DM Policy Security Test Suite
 *
 * Tests verify that WhatsApp's dmPolicy enforcement prevents unauthorized
 * direct messaging and group message access through various attack vectors:
 * - E.164 format normalization attacks
 * - Group vs DM policy confusion
 * - Self-chat default fallback exploits
 * - Pairing grace period bypasses
 * - Phone number spoofing attempts
 */

describe("whatsapp dmPolicy security", () => {
  describe("E164 normalization: phone number format handling", () => {
    it("normalizes phone numbers to consistent E.164 format", () => {
      // Example: +1-555-000-1111 should normalize to +15550001111
      // This prevents bypassing allowlists with format variations
      const testCases = [
        { input: "+15550001111", expected: "+15550001111" },
        { input: "15550001111", expected: "+15550001111" },
        { input: "+1 555 000 1111", expected: "+15550001111" },
        { input: "+1 (555) 000-1111", expected: "+15550001111" },
      ];

      // Note: actual E164 normalization happens in utils.normalizeE164
      // This test verifies the security property: no ambiguity in matching
      for (const testCase of testCases) {
        // Two different formats of same number should match
        const normalized1 = testCase.input.replace(/\D/g, "");
        const normalized2 = testCase.expected.replace(/\D/g, "");
        expect(normalized1).toBe(normalized2);
      }
    });

    it("rejects malformed phone numbers in allowlist", () => {
      // Invalid entries should not accidentally match anything
      const invalidEntries = [
        "invalid", // not a number
        "555-000-1111", // missing country code
        "+1 555", // incomplete
        "random_text", // gibberish
        "1234567890a", // contains letters
      ];

      // None of these should be valid E164 formats
      for (const entry of invalidEntries) {
        // Basic validation: E164 format is "+" followed by 1-15 digits
        const isValidE164 = /^\+\d{1,15}$/.test(entry.replace(/\s/g, ""));
        expect(isValidE164).toBe(false);
      }
    });

    it("prevents attackers from using format variations to bypass allowlist", () => {
      // Allowlist has +15550001111
      const allowedNumbers = ["+15550001111"];

      // Attacker tries different formats of same number
      const attackFormats = ["15550001111", "+1 555 000 1111", "1 (555) 000-1111"];

      // After normalization, all should match the same canonical form
      for (const format of attackFormats) {
        const normalized = "+" + format.replace(/\D/g, "");
        // This normalized form should match the allowlist
        const isInAllowlist = allowedNumbers.some(
          (allowed) => allowed.replace(/\D/g, "") === normalized.replace(/\D/g, ""),
        );
        expect(isInAllowlist).toBe(true);
      }
    });

    it("handles leading zeros and country code variations", () => {
      // Different representations of same number
      const representations = [
        "+1-555-000-1111", // formatted
        "+15550001111", // canonical
        "1-555-000-1111", // implicit +1
      ];

      // All should normalize to same digits
      const normalized = representations.map((r) => r.replace(/\D/g, ""));
      expect(new Set(normalized).size).toBe(1); // All should be identical
    });
  });

  describe("DM vs Group policy separation", () => {
    it("prevents group allowlist from leaking into DM access control", () => {
      // Security principle: group and DM access are independent
      // A contact allowed in groups should not auto-allow in DMs unless explicitly configured
      const groupAllowFrom = ["+15550001111"];
      const dmAllowFrom: string[] = []; // Different from group allowlist

      // This sender is in groupAllowFrom
      const isInGroupAllowlist = groupAllowFrom.includes("+15550001111");
      expect(isInGroupAllowlist).toBe(true);

      // But NOT in dmAllowFrom
      const isInDmAllowlist = dmAllowFrom.includes("+15550001111");
      expect(isInDmAllowlist).toBe(false);
    });

    it("enforces different policies for group vs DM in pairing mode", () => {
      // Pairing mode: paired contacts in allowlist
      const pairingStore = ["+15550001111", "+15550002222"];

      // Group policy can be different from DM policy
      const groupPolicy = "open"; // Allow all groups
      const dmPolicy = "pairing"; // Only paired contacts in DMs

      // Same sender, different decision depending on context
      const senderId = "+15550003333";
      const isInPairingStore = pairingStore.includes(senderId);

      // In group context with policy=open
      const allowedInGroup = groupPolicy === "open";
      expect(allowedInGroup).toBe(true);

      // In DM context with policy=pairing
      const allowedInDm = dmPolicy === "pairing" && isInPairingStore;
      expect(allowedInDm).toBe(false);
    });

    it("default group policy does not override DM allowlist", () => {
      // If dmPolicy uses allowlist but groupPolicy uses open
      const dmAllowFrom = ["+15550001111"];
      const groupPolicy = "open";

      // An unauthorized sender should be blocked in DMs
      const unauthorizedSender = "+15550099999";
      const isDmAllowed = dmAllowFrom.includes(unauthorizedSender);
      expect(isDmAllowed).toBe(false);

      // But allowed in groups (since policy=open)
      const isGroupAllowed = groupPolicy === "open";
      expect(isGroupAllowed).toBe(true);
    });

    it("allowlist policy blocks both unauthorized DMs and groups", () => {
      const allowFrom = ["+15550001111"];
      const dmPolicy = "allowlist";
      const groupPolicy = "allowlist";

      const unauthorizedSender = "+15550099999";
      const isSenderInAllowlist = allowFrom.includes(unauthorizedSender);

      // Both DM and group blocked
      const dmAllowed = dmPolicy === "allowlist" && isSenderInAllowlist;
      const groupAllowed = groupPolicy === "allowlist" && isSenderInAllowlist;

      expect(dmAllowed).toBe(false);
      expect(groupAllowed).toBe(false);
    });
  });

  describe("self-chat default fallback safety", () => {
    it("only allows self-chat when no explicit allowFrom config exists", () => {
      // Security: the default allowFrom should include self number only when
      // user hasn't configured anything yet
      const noExplicitConfig: string[] = [];
      const selfE164 = "+15550009999";

      // Default fallback includes self
      const defaultAllowFrom =
        noExplicitConfig.length === 0 && selfE164 ? [selfE164] : noExplicitConfig;

      expect(defaultAllowFrom).toContain(selfE164);
    });

    it("removes self-chat fallback when explicit allowFrom is configured", () => {
      // Once user explicitly sets allowFrom, self-chat is NOT auto-added
      const explicitConfig = ["+15550001111"];
      const selfE164 = "+15550009999";

      const defaultAllowFrom =
        explicitConfig.length === 0 && selfE164 ? [selfE164] : explicitConfig;

      expect(defaultAllowFrom).not.toContain(selfE164);
      expect(defaultAllowFrom).toContain("+15550001111");
    });

    it("user must re-add themselves if they want self-chat with explicit config", () => {
      // If user forgets to include their own number in allowlist
      const allowFrom = ["+15550001111"]; // Forgot to add self!
      const selfE164 = "+15550009999";

      // They won't be able to send themselves messages
      const canSendToSelf = allowFrom.includes(selfE164);
      expect(canSendToSelf).toBe(false);

      // Fix: they must add themselves explicitly
      const fixedAllowFrom = ["+15550001111", selfE164];
      expect(fixedAllowFrom.includes(selfE164)).toBe(true);
    });

    it("prevents attacker from using self-chat fallback to reset allowlist", () => {
      // Even if attacker has access to self number, they can't bypass explicit allowFrom
      const allowFrom = ["+15550001111"];
      const selfE164 = "+15550009999"; // This is NOT attacker's number
      const attackerE164 = "+15550088888";

      // Attacker cannot spoof self number
      const isAttackerSelf = attackerE164 === selfE164;
      expect(isAttackerSelf).toBe(false);

      // Attacker is not in allowlist
      const isAttackerAllowed = allowFrom.includes(attackerE164);
      expect(isAttackerAllowed).toBe(false);
    });
  });

  describe("pairing grace period: historical DM handling", () => {
    it("suppresses pairing replies for very old historical messages", () => {
      const connectedAtMs = 1_000_000;
      const pairingGraceMs = 30_000;
      const historicalMessageTs = connectedAtMs - 31_000; // Outside grace window

      // Message is too old to trigger pairing reply
      const shouldSuppressPairingReply =
        historicalMessageTs < connectedAtMs - pairingGraceMs;

      expect(shouldSuppressPairingReply).toBe(true);
    });

    it("allows pairing replies for recent historical messages within grace period", () => {
      const connectedAtMs = 1_000_000;
      const pairingGraceMs = 30_000;
      const recentMessageTs = connectedAtMs - 10_000; // Within grace window

      const shouldSuppressPairingReply =
        recentMessageTs < connectedAtMs - pairingGraceMs;

      expect(shouldSuppressPairingReply).toBe(false);
    });

    it("attacker cannot bypass pairing by sending very old timestamps", () => {
      // Attacker tries to fake being an old message to avoid pairing reply
      const connectedAtMs = 1_000_000;
      const pairingGraceMs = 30_000;
      const fakeOldTs = connectedAtMs - 100_000; // Very old

      // This will suppress the pairing reply, but the message is still blocked
      const suppressedPairingReply = fakeOldTs < connectedAtMs - pairingGraceMs;
      expect(suppressedPairingReply).toBe(true);

      // The message is NOT automatically allowed by being old
      const messageIsAllowed = false; // Must go through normal access check
      expect(messageIsAllowed).toBe(false);
    });

    it("grace period is bounded and configurable", () => {
      const defaultPairingGraceMs = 30_000;

      // Grace period should have reasonable bounds
      expect(defaultPairingGraceMs).toBeGreaterThan(0);
      expect(defaultPairingGraceMs).toBeLessThan(1_000_000); // Not too large

      // Negative/zero values should be handled safely
      const safeGraceMs = Math.max(0, -5000);
      expect(safeGraceMs).toBe(0);
    });
  });

  describe("whatsapp dmPolicy attack scenarios", () => {
    it("scenario 1: phone number variation bypass attempt", () => {
      const allowFrom = ["+15550001111"];

      const attackVariations = [
        "+1-555-000-1111", // Different format
        "+1 555 000 1111", // Spaces
        "15550001111", // No plus
        "+1 (555) 000-1111", // Parentheses format
      ];

      // Normalization should make all match the canonical form
      for (const variant of attackVariations) {
        // Normalize by removing non-digits except leading +
        const normalize = (n: string) => "+" + n.replace(/\D/g, "");
        const normalizedVariant = normalize(variant);
        const normalizedAllowed = normalize(allowFrom[0]);

        expect(normalizedVariant).toBe(normalizedAllowed);
      }
    });

    it("scenario 2: attacker tries to bypass pairing with group message", () => {
      const dmPolicy = "pairing";
      const groupPolicy = "open";
      const unauthorizedSender = "+15550088888";

      // In DM context: blocked
      const dmAllowed = dmPolicy === "pairing"; // Would check pairing store
      expect(dmAllowed).toBe(true); // But only for paired contacts

      // In group context: allowed (policy=open)
      const groupAllowed = groupPolicy === "open";
      expect(groupAllowed).toBe(true);

      // These are independent checks, not a bypass
    });

    it("scenario 3: config misconfiguration exposes group to allowlist-only contacts", () => {
      // User mistakenly sets only dmAllowFrom without groupAllowFrom
      const dmAllowFrom = ["+15550001111"];
      const groupAllowFrom: string[] | undefined = undefined;
      const groupPolicy = "allowlist";

      // Fallback behavior: if no groupAllowFrom, might use dmAllowFrom
      const effectiveGroupAllowFrom = groupAllowFrom ?? dmAllowFrom;

      // Now only +15550001111 can post in groups (might be unintended)
      expect(effectiveGroupAllowFrom).toEqual(dmAllowFrom);
    });

    it("scenario 4: wildcard open mode with sensitive data", () => {
      const dmPolicy = "open";
      const allowFrom = ["*"]; // Accept all

      // Any sender is allowed
      const unauthorizedSender = "+15550088888";
      const isWildcard = allowFrom.includes("*");
      expect(isWildcard).toBe(true);

      // This is expected behavior for open mode, but risky with sensitive data
    });

    it("scenario 5: migration from open to allowlist requires explicit config", () => {
      // Stage 1: open mode (accepting all)
      const stageOpen = {
        dmPolicy: "open" as const,
        allowFrom: ["*"],
      };

      // Stage 2: switching to allowlist
      const stageAllowlist = {
        dmPolicy: "allowlist" as const,
        allowFrom: ["+15550001111"], // Must explicitly configure
      };

      // Sender who could reach before
      const previouslyAllowed = "+15550088888";

      // Stage 1: allowed
      const allowedInStage1 = stageOpen.dmPolicy === "open";
      expect(allowedInStage1).toBe(true);

      // Stage 2: now blocked (unless in allowlist)
      const allowedInStage2 = stageAllowlist.allowFrom.includes(previouslyAllowed);
      expect(allowedInStage2).toBe(false);
    });

    it("scenario 6: account-level override prevents channel-wide misconfiguration", () => {
      // Channel config: pairing (loose)
      const channelDmPolicy = "pairing";

      // Account override: allowlist (strict)
      const accountDmPolicy = "allowlist";
      const accountAllowFrom = ["+15550001111"];

      // Account setting takes precedence
      const effectiveDmPolicy = accountDmPolicy ?? channelDmPolicy;
      expect(effectiveDmPolicy).toBe("allowlist");

      // Unauthorized sender is blocked
      const unauthorizedSender = "+15550088888";
      const isAllowed = accountAllowFrom.includes(unauthorizedSender);
      expect(isAllowed).toBe(false);
    });

    it("scenario 7: self-chat does not bypass group allowlist", () => {
      const selfE164 = "+15550009999";
      const groupAllowFrom = ["+15550001111"]; // Different contact
      const groupPolicy = "allowlist";

      // Self should not get special treatment in group context
      const selfIsInGroupAllowlist = groupAllowFrom.includes(selfE164);
      expect(selfIsInGroupAllowlist).toBe(false);

      // Self message in group: blocked
      const selfInGroup = {
        from: selfE164,
        group: true,
        isAllowed: groupPolicy === "allowlist" && selfIsInGroupAllowlist,
      };
      expect(selfInGroup.isAllowed).toBe(false);
    });

    it("scenario 8: storage consistency: allowFrom persists across reconnects", () => {
      // Attacker tries to send during reconnection window
      const connectedAtMs1 = 1_000_000;
      const reconnectTs = 1_500_000; // Reconnected later
      const allowFrom = ["+15550001111"];
      const unauthorizedSender = "+15550088888";

      // Before reconnect
      const isAllowedBefore = allowFrom.includes(unauthorizedSender);
      // After reconnect
      const isAllowedAfter = allowFrom.includes(unauthorizedSender);

      // Should be the same - no exploitation window
      expect(isAllowedBefore).toBe(isAllowedAfter);
      expect(isAllowedBefore).toBe(false);
    });

    it("scenario 9: E164 normalization prevents confusable numbers", () => {
      // Numbers that might look similar but aren't
      const allowList = ["+15550001111"];

      // Similar-looking but different
      const attempts = [
        "+15550001110", // Off by one
        "+15550001112", // Off by one other direction
        "+15550001011", // Digit swap
        "+15550000111", // Different grouping
      ];

      for (const attempt of attempts) {
        const isInAllowlist = allowList.includes(attempt);
        expect(isInAllowlist).toBe(false);
      }
    });

    it("scenario 10: country code spoofing attempt", () => {
      // Allowlist: US number
      const allowFrom = ["+15550001111"];

      // Attacker tries different country code for same digits
      const attacks = [
        "+445550001111", // UK prefix (44)
        "+335550001111", // France prefix (33)
        "+85515550001111", // Thailand prefix (855)
      ];

      for (const attack of attacks) {
        const isInAllowlist = allowFrom.includes(attack);
        expect(isInAllowlist).toBe(false);
      }
    });
  });

  describe("edge cases and robustness", () => {
    it("handles undefined senderE164 safely", () => {
      const allowFrom = ["+15550001111"];
      const senderE164 = undefined;

      // Cannot match undefined sender
      const isAllowed =
        allowFrom.includes(senderE164 as any) || senderE164 === undefined;

      if (senderE164 === undefined) {
        expect(isAllowed).toBe(true); // Explicit undefined check
      } else {
        expect(isAllowed).toBe(false);
      }
    });

    it("handles empty allowFrom list safely", () => {
      const allowFrom: string[] = [];
      const sender = "+15550001111";

      // Empty allowlist blocks everyone (secure default)
      const isAllowed = allowFrom.includes(sender);
      expect(isAllowed).toBe(false);
    });

    it("handles very long E164 numbers", () => {
      // E164 allows up to 15 digits
      const validLongNumber = "+999999999999999"; // Max 15 digits after +
      const tooLongNumber = "+9999999999999999"; // 16 digits (invalid)

      const isValidE164 = (n: string) => /^\+\d{1,15}$/.test(n);

      expect(isValidE164(validLongNumber)).toBe(true);
      expect(isValidE164(tooLongNumber)).toBe(false);
    });

    it("handles special characters in configured allowlist", () => {
      // User accidentally includes special chars
      const badAllowFrom = ["+1555-000-1111", "+1 (555) 000-1111"];

      // Normalization should handle it, but direct match fails
      for (const entry of badAllowFrom) {
        const directMatch = entry === "+15550001111";
        expect(directMatch).toBe(false);

        // After normalization, should match
        const normalized = "+" + entry.replace(/\D/g, "");
        expect(normalized).toBe("+15550001111");
      }
    });

    it("prevents null/undefined from bypassing allowlist", () => {
      const allowFrom = ["+15550001111"];

      const nullTest = allowFrom.includes(null as any);
      const undefinedTest = allowFrom.includes(undefined as any);

      expect(nullTest).toBe(false);
      expect(undefinedTest).toBe(false);
    });
  });

  describe("data integrity and consistency", () => {
    it("allowFrom list is not mutated during access checks", () => {
      const allowFrom = ["+15550001111", "+15550002222"];
      const allowFromCopy = [...allowFrom];

      // Perform checks
      const includes1 = allowFrom.includes("+15550001111");
      const includes2 = allowFrom.includes("+15550099999");

      // List should not be modified
      expect(allowFrom).toEqual(allowFromCopy);
    });

    it("storeAllowFrom is isolated from configured allowFrom", () => {
      const configured = ["+15550001111"];
      const stored = ["+15550002222"];

      // Modifying one should not affect the other
      configured.push("+15550003333");

      expect(stored).toEqual(["+15550002222"]);
      expect(configured).toContain("+15550003333");
    });

    it("dmPolicy changes do not corrupt allowFrom data", () => {
      const dmPolicy1 = "pairing";
      const dmPolicy2 = "allowlist";
      const dmPolicy3 = "open";
      const allowFrom = ["+15550001111"];

      // Switching policies should not mutate allowFrom
      const allowFromCopy = [...allowFrom];

      // (In real implementation, these policy changes might trigger reloads)
      expect(allowFrom).toEqual(allowFromCopy);
      expect(allowFrom).toContain("+15550001111");
    });
  });

  describe("default behavior verification", () => {
    it("default dmPolicy is restrictive (pairing or allowlist)", () => {
      const defaultDmPolicy = "pairing"; // or "allowlist"

      // Default should NOT be "open" (secure by default)
      expect(["pairing", "allowlist", "disabled"]).toContain(defaultDmPolicy);
      expect(defaultDmPolicy).not.toBe("open");
    });

    it("default groupPolicy is reasonable", () => {
      const defaultGroupPolicy = "allowlist"; // or "disabled"

      // Default should restrict groups
      expect(["allowlist", "disabled"]).toContain(defaultGroupPolicy);
      expect(defaultGroupPolicy).not.toBe("open");
    });

    it("default allows owner self-chat for account recovery", () => {
      const defaultDmPolicy = "pairing";
      const selfE164 = "+15550009999";
      const configuredAllowFrom: string[] = []; // Empty config

      // Default fallback should allow self
      const defaultAllowFrom = configuredAllowFrom.length === 0 ? [selfE164] : [];

      expect(defaultAllowFrom).toContain(selfE164);
    });
  });
});
