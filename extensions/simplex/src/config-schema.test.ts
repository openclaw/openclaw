import { describe, expect, it } from "vitest";
import { SimplexConfigSchema } from "./config-schema.js";

describe("config-schema", () => {
  describe("SimplexConfigSchema validation", () => {
    it("passes with valid minimal config", () => {
      const config = {
        wsPort: 5225,
      };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("passes with valid full config", () => {
      const config = {
        name: "My SimpleX",
        enabled: true,
        wsUrl: "ws://localhost:5225",
        wsPort: 5225,
        wsHost: "127.0.0.1",
        autoAcceptContacts: false,
        dmPolicy: "pairing",
        allowFrom: ["user1", "user2"],
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
        groupRouting: [
          {
            groupName: "TeamChat",
            agent: "team-agent",
            language: "en",
            voiceReplies: false,
            includeHistory: true,
            maxHistoryMessages: 20,
            priority: 50,
          },
        ],
        defaultAgent: "default-agent",
        defaultLanguage: "en",
        defaultModel: "claude-sonnet",
        defaultVoiceReplies: false,
        cliPath: "/usr/local/bin/simplex-chat",
        dbPath: "/home/user/.simplex",
        autoStart: false,
        filterMemberIds: ["1", "2"],
        filterDisplayNames: ["BotDevice"],
        storeHistory: true,
        maxStoredHistory: 50,
      };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("applies default values", () => {
      const config = {};
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.defaultLanguage).toBe("en");
        expect(result.data.defaultVoiceReplies).toBe(false);
        expect(result.data.storeHistory).toBe(true);
        expect(result.data.maxStoredHistory).toBe(50);
      }
    });
  });

  describe("required fields validation", () => {
    it("fails when required fields are missing (wsPort as only required-like field)", () => {
      // Note: In the schema, wsPort is optional with default, so we test with invalid type
      const config = {
        wsPort: "not-a-number" as unknown,
      };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("fails with invalid dmPolicy", () => {
      const config = {
        dmPolicy: "invalid-policy",
      };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe("port range validation", () => {
    it("accepts valid port numbers", () => {
      expect(SimplexConfigSchema.safeParse({ wsPort: 1 }).success).toBe(true);
      expect(SimplexConfigSchema.safeParse({ wsPort: 80 }).success).toBe(true);
      expect(SimplexConfigSchema.safeParse({ wsPort: 443 }).success).toBe(true);
      expect(SimplexConfigSchema.safeParse({ wsPort: 5225 }).success).toBe(true);
      expect(SimplexConfigSchema.safeParse({ wsPort: 65535 }).success).toBe(true);
    });

    it("rejects port number below 1", () => {
      const config = { wsPort: 0 };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("rejects port number above 65535", () => {
      const config = { wsPort: 65536 };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("rejects negative port numbers", () => {
      const config = { wsPort: -1 };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("rejects non-integer port numbers", () => {
      const config = { wsPort: 8080.5 };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe("userRouting validation", () => {
    it("passes with valid userRouting", () => {
      const config = {
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
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("passes with optional fields omitted", () => {
      const config = {
        userRouting: [
          {
            contactName: "Alice",
            agent: "alice-agent",
          },
        ],
      };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.userRouting?.[0].language).toBe("fr"); // default
        expect(result.data.userRouting?.[0].voiceReplies).toBe(true); // default
      }
    });

    it("fails with missing contactName", () => {
      const config = {
        userRouting: [
          {
            agent: "alice-agent",
          },
        ],
      };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("fails with missing agent", () => {
      const config = {
        userRouting: [
          {
            contactName: "Alice",
          },
        ],
      };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("fails with invalid maxHistoryMessages range", () => {
      const config = {
        userRouting: [
          {
            contactName: "Alice",
            agent: "alice-agent",
            maxHistoryMessages: 0,
          },
        ],
      };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("fails with priority out of range", () => {
      const config = {
        userRouting: [
          {
            contactName: "Alice",
            agent: "alice-agent",
            priority: 150,
          },
        ],
      };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe("groupRouting validation", () => {
    it("passes with valid groupRouting", () => {
      const config = {
        groupRouting: [
          {
            groupName: "TeamChat",
            agent: "team-agent",
            language: "en",
            voiceReplies: false,
            memberFilter: ["Alice", "Bob"],
            memberExclude: ["Bot"],
            priority: 50,
          },
        ],
      };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("passes with empty memberFilter and memberExclude", () => {
      const config = {
        groupRouting: [
          {
            groupName: "TeamChat",
            agent: "team-agent",
            memberFilter: [],
            memberExclude: [],
          },
        ],
      };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("fails with missing groupName", () => {
      const config = {
        groupRouting: [
          {
            agent: "team-agent",
          },
        ],
      };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("fails with invalid maxStoredHistory", () => {
      const config = {
        maxStoredHistory: 0,
      };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe("wsUrl validation", () => {
    it("accepts valid wsUrl", () => {
      expect(SimplexConfigSchema.safeParse({ wsUrl: "ws://localhost:5225" }).success).toBe(true);
      expect(SimplexConfigSchema.safeParse({ wsUrl: "wss://secure.example.com:443" }).success).toBe(
        true,
      );
    });

    it("accepts config without wsUrl (uses defaults)", () => {
      const result = SimplexConfigSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });

  describe("reconnection config validation", () => {
    it("passes with valid reconnection config", () => {
      const config = {
        reconnection: {
          maxRetries: 10,
          backoffMs: 1000,
          backoffFactor: 2.0,
        },
      };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("fails with negative maxRetries", () => {
      const config = {
        reconnection: {
          maxRetries: -1,
        },
      };
      const result = SimplexConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });
});
