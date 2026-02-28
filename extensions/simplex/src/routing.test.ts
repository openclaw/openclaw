import { describe, expect, it } from "vitest";
import type { SimplexConfig } from "./config-schema.js";
import { resolveRouting, shouldRouteToAgent, describeRouting } from "./routing.js";

describe("routing", () => {
  const baseConfig: SimplexConfig = {
    defaultAgent: "default-agent",
    defaultLanguage: "en",
    defaultVoiceReplies: false,
    userRouting: [],
    groupRouting: [],
  };

  describe("resolveRouting", () => {
    it("returns null when no routing configured and no default agent", () => {
      const config: SimplexConfig = {
        userRouting: [],
        groupRouting: [],
      };
      const ctx = {
        senderName: "Alice",
        senderId: "123",
        isGroup: false,
      };

      const result = resolveRouting(config, ctx);
      expect(result).toBeNull();
    });

    it("falls back to default agent when no route matches", () => {
      const config: SimplexConfig = {
        ...baseConfig,
        defaultAgent: "fallback-agent",
        defaultLanguage: "fr",
        defaultVoiceReplies: true,
      };
      const ctx = {
        senderName: "UnknownUser",
        senderId: "999",
        isGroup: false,
      };

      const result = resolveRouting(config, ctx);
      expect(result).not.toBeNull();
      expect(result!.agent).toBe("fallback-agent");
      expect(result!.language).toBe("fr");
      expect(result!.voiceReplies).toBe(true);
    });

    describe("direct message routing", () => {
      it("matches direct message by contact name (case-insensitive)", () => {
        const config: SimplexConfig = {
          ...baseConfig,
          userRouting: [
            {
              contactName: "Alice",
              agent: "alice-agent",
              language: "en",
              voiceReplies: true,
              includeHistory: true,
              maxHistoryMessages: 10,
              priority: 50,
            },
          ],
        };
        const ctx = {
          senderName: "ALICE",
          senderId: "123",
          isGroup: false,
        };

        const result = resolveRouting(config, ctx);
        expect(result).not.toBeNull();
        expect(result!.agent).toBe("alice-agent");
      });

      it("matches contact name with mixed case", () => {
        const config: SimplexConfig = {
          ...baseConfig,
          userRouting: [
            {
              contactName: "JohnDoe",
              agent: "john-agent",
              language: "fr",
              voiceReplies: false,
              includeHistory: true,
              maxHistoryMessages: 5,
              priority: 50,
            },
          ],
        };
        const ctx = {
          senderName: "johndoe",
          senderId: "456",
          isGroup: false,
        };

        const result = resolveRouting(config, ctx);
        expect(result).not.toBeNull();
        expect(result!.agent).toBe("john-agent");
        expect(result!.language).toBe("fr");
      });

      it("returns null when no matching contact name", () => {
        const config: SimplexConfig = {
          ...baseConfig,
          userRouting: [
            {
              contactName: "Alice",
              agent: "alice-agent",
              language: "en",
              voiceReplies: true,
              includeHistory: true,
              maxHistoryMessages: 10,
              priority: 50,
            },
          ],
        };
        const ctx = {
          senderName: "Bob",
          senderId: "789",
          isGroup: false,
        };

        const result = resolveRouting(config, ctx);
        // Should fall back to default agent
        expect(result?.agent).toBe("default-agent");
      });
    });

    describe("group routing", () => {
      it("matches group by group name (case-insensitive)", () => {
        const config: SimplexConfig = {
          ...baseConfig,
          groupRouting: [
            {
              groupName: "EffuzionNext",
              agent: "group-agent",
              language: "fr",
              voiceReplies: false,
              includeHistory: true,
              maxHistoryMessages: 20,
              priority: 50,
            },
          ],
        };
        const ctx = {
          senderName: "Member1",
          senderId: "123",
          isGroup: true,
          groupName: "effuzionnext",
          groupId: "g1",
        };

        const result = resolveRouting(config, ctx);
        expect(result).not.toBeNull();
        expect(result!.agent).toBe("group-agent");
        expect(result!.language).toBe("fr");
      });

      it("filters group routing by member filter", () => {
        const config: SimplexConfig = {
          ...baseConfig,
          groupRouting: [
            {
              groupName: "TeamChat",
              agent: "team-agent",
              language: "en",
              voiceReplies: true,
              includeHistory: true,
              maxHistoryMessages: 10,
              memberFilter: ["Alice", "Bob"],
              priority: 50,
            },
          ],
        };
        const ctx = {
          senderName: "Alice",
          senderId: "123",
          isGroup: true,
          groupName: "TeamChat",
          groupId: "g1",
        };

        const result = resolveRouting(config, ctx);
        expect(result).not.toBeNull();
        expect(result!.agent).toBe("team-agent");
      });

      it("excludes members from group routing", () => {
        const config: SimplexConfig = {
          ...baseConfig,
          groupRouting: [
            {
              groupName: "TeamChat",
              agent: "team-agent",
              language: "en",
              voiceReplies: true,
              includeHistory: true,
              maxHistoryMessages: 10,
              memberExclude: ["BotDevice", "AutomatedAccount"],
              priority: 50,
            },
          ],
        };
        const ctx = {
          senderName: "BotDevice",
          senderId: "bot",
          isGroup: true,
          groupName: "TeamChat",
          groupId: "g1",
        };

        const result = resolveRouting(config, ctx);
        // Should fall through to default since sender is excluded
        expect(result?.agent).toBe("default-agent");
      });

      it("respects priority ordering for multiple group routes", () => {
        const config: SimplexConfig = {
          ...baseConfig,
          groupRouting: [
            {
              groupName: "TeamChat",
              agent: "low-priority-agent",
              language: "en",
              voiceReplies: false,
              includeHistory: true,
              maxHistoryMessages: 10,
              priority: 10,
            },
            {
              groupName: "TeamChat",
              agent: "high-priority-agent",
              language: "fr",
              voiceReplies: true,
              includeHistory: true,
              maxHistoryMessages: 20,
              priority: 100,
            },
          ],
        };
        const ctx = {
          senderName: "AnyMember",
          senderId: "123",
          isGroup: true,
          groupName: "TeamChat",
          groupId: "g1",
        };

        const result = resolveRouting(config, ctx);
        expect(result).not.toBeNull();
        // Higher priority should win
        expect(result!.agent).toBe("high-priority-agent");
        expect(result!.language).toBe("fr");
        expect(result!.voiceReplies).toBe(true);
      });

      it("skips excluded members and falls to next matching route", () => {
        const config: SimplexConfig = {
          ...baseConfig,
          groupRouting: [
            {
              groupName: "TeamChat",
              agent: "everyone-agent",
              language: "en",
              voiceReplies: false,
              includeHistory: true,
              maxHistoryMessages: 10,
              memberExclude: ["SpecificUser"],
              priority: 50,
            },
            {
              groupName: "TeamChat",
              agent: "specific-agent",
              language: "de",
              voiceReplies: true,
              includeHistory: true,
              maxHistoryMessages: 5,
              memberFilter: ["SpecificUser"],
              priority: 100,
            },
          ],
        };
        const ctx = {
          senderName: "SpecificUser",
          senderId: "123",
          isGroup: true,
          groupName: "TeamChat",
          groupId: "g1",
        };

        const result = resolveRouting(config, ctx);
        expect(result).not.toBeNull();
        // Should match second route (specific-agent) since first excluded this user
        expect(result!.agent).toBe("specific-agent");
      });
    });

    it("returns default agent when defaultAgent is configured", () => {
      const config: SimplexConfig = {
        userRouting: [],
        groupRouting: [],
        defaultAgent: "my-default-agent",
        defaultLanguage: "es",
        defaultVoiceReplies: true,
      };
      const ctx = {
        senderName: "RandomUser",
        senderId: "999",
        isGroup: false,
      };

      const result = resolveRouting(config, ctx);
      expect(result).not.toBeNull();
      expect(result!.agent).toBe("my-default-agent");
      expect(result!.language).toBe("es");
      expect(result!.voiceReplies).toBe(true);
    });
  });

  describe("shouldRouteToAgent", () => {
    it("returns true when routing is found", () => {
      const config: SimplexConfig = {
        ...baseConfig,
        userRouting: [
          {
            contactName: "Alice",
            agent: "alice-agent",
            language: "en",
            voiceReplies: true,
            includeHistory: true,
            maxHistoryMessages: 10,
            priority: 50,
          },
        ],
      };
      const ctx = {
        senderName: "Alice",
        senderId: "123",
        isGroup: false,
      };

      expect(shouldRouteToAgent(config, ctx)).toBe(true);
    });

    it("returns false when no routing and no default agent", () => {
      const config: SimplexConfig = {
        userRouting: [],
        groupRouting: [],
      };
      const ctx = {
        senderName: "Unknown",
        senderId: "999",
        isGroup: false,
      };

      expect(shouldRouteToAgent(config, ctx)).toBe(false);
    });
  });

  describe("describeRouting", () => {
    it("describes resolved routing", () => {
      const config: SimplexConfig = {
        ...baseConfig,
        userRouting: [
          {
            contactName: "Alice",
            agent: "alice-agent",
            language: "fr",
            voiceReplies: true,
            includeHistory: true,
            maxHistoryMessages: 10,
            priority: 50,
          },
        ],
      };
      const ctx = {
        senderName: "Alice",
        senderId: "123",
        isGroup: false,
      };

      const description = describeRouting(config, ctx);
      expect(description).toContain("alice-agent");
      expect(description).toContain("lang:fr");
      expect(description).toContain("voice:true");
    });

    it("describes no routing found", () => {
      const config: SimplexConfig = {
        userRouting: [],
        groupRouting: [],
      };
      const ctx = {
        senderName: "Unknown",
        senderId: "999",
        isGroup: false,
      };

      const description = describeRouting(config, ctx);
      expect(description).toContain("No routing configured");
    });
  });
});
