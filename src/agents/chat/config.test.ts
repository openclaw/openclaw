import { describe, it, expect } from "vitest";
import {
  validateConfig,
  mergeConfig,
  DEFAULT_CONFIG,
  EXAMPLE_CONFIG_YAML,
  type AgentChannelsConfig,
} from "./config.js";

describe("config", () => {
  describe("validateConfig", () => {
    it("should accept valid config with no channels", () => {
      const errors = validateConfig({ ...DEFAULT_CONFIG, channels: [] });
      expect(errors).toHaveLength(0);
    });

    it("should accept valid config with channels", () => {
      const config: AgentChannelsConfig = {
        ...DEFAULT_CONFIG,
        channels: [
          {
            id: "general",
            name: "General",
            type: "public",
            members: [
              { agentId: "main", role: "admin", listeningMode: "active" },
              { agentId: "coder", role: "member", listeningMode: "mention-only" },
            ],
          },
        ],
      };

      const errors = validateConfig(config);
      expect(errors).toHaveLength(0);
    });

    it("should reject invalid channel type", () => {
      const config: AgentChannelsConfig = {
        ...DEFAULT_CONFIG,
        // oxlint-disable-next-line typescript/no-explicit-any
        channels: [{ id: "test", name: "Test", type: "invalid" as any, members: [] }],
      };

      const errors = validateConfig(config);
      expect(errors.some((e) => e.includes("invalid type"))).toBe(true);
    });

    it("should reject invalid member role", () => {
      const config: AgentChannelsConfig = {
        ...DEFAULT_CONFIG,
        channels: [
          {
            id: "test",
            name: "Test",
            type: "public",
            // oxlint-disable-next-line typescript/no-explicit-any
            members: [{ agentId: "agent1", role: "superuser" as any, listeningMode: "active" }],
          },
        ],
      };

      const errors = validateConfig(config);
      expect(errors.some((e) => e.includes("invalid role"))).toBe(true);
    });

    it("should reject invalid listening mode", () => {
      const config: AgentChannelsConfig = {
        ...DEFAULT_CONFIG,
        channels: [
          {
            id: "test",
            name: "Test",
            type: "public",
            // oxlint-disable-next-line typescript/no-explicit-any
            members: [{ agentId: "agent1", role: "member", listeningMode: "always-on" as any }],
          },
        ],
      };

      const errors = validateConfig(config);
      expect(errors.some((e) => e.includes("invalid listeningMode"))).toBe(true);
    });

    it("should reject empty channel id", () => {
      const config: AgentChannelsConfig = {
        ...DEFAULT_CONFIG,
        channels: [{ id: "", name: "Test", type: "public", members: [] }],
      };

      const errors = validateConfig(config);
      expect(errors.some((e) => e.includes("id"))).toBe(true);
    });

    it("should reject duplicate channel ids", () => {
      const config: AgentChannelsConfig = {
        ...DEFAULT_CONFIG,
        channels: [
          { id: "general", name: "General", type: "public", members: [] },
          { id: "general", name: "General 2", type: "public", members: [] },
        ],
      };

      const errors = validateConfig(config);
      expect(errors.some((e) => e.includes("Duplicate"))).toBe(true);
    });

    it("should reject duplicate members in a channel", () => {
      const config: AgentChannelsConfig = {
        ...DEFAULT_CONFIG,
        channels: [
          {
            id: "test",
            name: "Test",
            type: "public",
            members: [
              { agentId: "agent1", role: "member" },
              { agentId: "agent1", role: "admin" },
            ],
          },
        ],
      };

      const errors = validateConfig(config);
      expect(errors.some((e) => e.includes("duplicate member"))).toBe(true);
    });

    it("should reject member without agentId", () => {
      const config: AgentChannelsConfig = {
        ...DEFAULT_CONFIG,
        channels: [
          {
            id: "test",
            name: "Test",
            type: "public",
            // oxlint-disable-next-line typescript/no-explicit-any
            members: [{ agentId: "", role: "member" } as any],
          },
        ],
      };

      const errors = validateConfig(config);
      expect(errors.some((e) => e.includes("agentId"))).toBe(true);
    });

    it("should accept valid expertise mapping", () => {
      const config: AgentChannelsConfig = {
        ...DEFAULT_CONFIG,
        collaboration: {
          expertiseMapping: {
            code: ["coder", "reviewer"],
            research: ["researcher"],
          },
        },
      };

      const errors = validateConfig(config);
      expect(errors).toHaveLength(0);
    });
  });

  describe("mergeConfig", () => {
    it("should merge user config with defaults", () => {
      const merged = mergeConfig({ enabled: false });

      expect(merged.enabled).toBe(false);
      // Should keep defaults
      expect(merged.database?.postgres?.host).toBe("localhost");
      expect(merged.database?.redis?.port).toBe(6379);
    });

    it("should override nested database settings", () => {
      const merged = mergeConfig({
        enabled: true,
        database: {
          postgres: {
            host: "production-host",
            port: 5433,
            database: "prod_db",
            user: "prod_user",
            password: "secret",
          },
        },
      });

      expect(merged.database?.postgres?.host).toBe("production-host");
      expect(merged.database?.postgres?.port).toBe(5433);
      // Redis should still have defaults
      expect(merged.database?.redis?.host).toBe("localhost");
    });

    it("should override presence settings", () => {
      const merged = mergeConfig({
        enabled: true,
        presence: {
          ttlSeconds: 600,
          heartbeatIntervalSeconds: 120,
        },
      });

      expect(merged.presence?.ttlSeconds).toBe(600);
      expect(merged.presence?.heartbeatIntervalSeconds).toBe(120);
    });

    it("should override autoJoin settings", () => {
      const merged = mergeConfig({
        enabled: true,
        autoJoin: {
          agentPatterns: ["coder-*"],
          defaultActivation: {
            mode: "active",
          },
        },
      });

      expect(merged.autoJoin?.agentPatterns).toEqual(["coder-*"]);
      expect(merged.autoJoin?.defaultActivation?.mode).toBe("active");
    });
  });

  describe("DEFAULT_CONFIG", () => {
    it("should have sensible defaults", () => {
      expect(DEFAULT_CONFIG.enabled).toBe(true);
      expect(DEFAULT_CONFIG.database?.postgres?.port).toBe(5432);
      expect(DEFAULT_CONFIG.database?.redis?.port).toBe(6379);
      expect(DEFAULT_CONFIG.presence?.ttlSeconds).toBeGreaterThan(0);
      expect(DEFAULT_CONFIG.presence?.typingTtlSeconds).toBeGreaterThan(0);
      expect(DEFAULT_CONFIG.messages?.maxLength).toBeGreaterThan(0);
    });

    it("should pass its own validation", () => {
      const errors = validateConfig(DEFAULT_CONFIG);
      expect(errors).toHaveLength(0);
    });
  });

  describe("EXAMPLE_CONFIG_YAML", () => {
    it("should be a non-empty string", () => {
      expect(typeof EXAMPLE_CONFIG_YAML).toBe("string");
      expect(EXAMPLE_CONFIG_YAML.length).toBeGreaterThan(100);
    });

    it("should contain key configuration sections", () => {
      expect(EXAMPLE_CONFIG_YAML).toContain("agentChannels:");
      expect(EXAMPLE_CONFIG_YAML).toContain("channels:");
      expect(EXAMPLE_CONFIG_YAML).toContain("collaboration:");
      expect(EXAMPLE_CONFIG_YAML).toContain("presence:");
      expect(EXAMPLE_CONFIG_YAML).toContain("bindings:");
    });

    it("should demonstrate different roles and modes", () => {
      expect(EXAMPLE_CONFIG_YAML).toContain("role: admin");
      expect(EXAMPLE_CONFIG_YAML).toContain("role: member");
      expect(EXAMPLE_CONFIG_YAML).toContain("listeningMode: active");
      expect(EXAMPLE_CONFIG_YAML).toContain("listeningMode: mention-only");
    });
  });
});
