import { describe, expect, it } from "vitest";
import { sanitizeEnvVars, getBlockedPatterns, getAllowedPatterns } from "./sanitize-env-vars.js";

describe("sanitizeEnvVars", () => {
  describe("blocks sensitive credentials", () => {
    it("blocks ANTHROPIC_API_KEY", () => {
      const result = sanitizeEnvVars({ ANTHROPIC_API_KEY: "sk-ant-test123" });
      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].key).toBe("ANTHROPIC_API_KEY");
      expect(result.blocked[0].reason).toContain("blocked credential pattern");
      expect(result.allowed).toEqual({});
    });

    it("blocks OPENAI_API_KEY", () => {
      const result = sanitizeEnvVars({ OPENAI_API_KEY: "sk-test123" });
      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].key).toBe("OPENAI_API_KEY");
    });

    it("blocks OPENCLAW_GATEWAY_TOKEN", () => {
      const result = sanitizeEnvVars({ OPENCLAW_GATEWAY_TOKEN: "token123" });
      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].key).toBe("OPENCLAW_GATEWAY_TOKEN");
    });

    it("blocks bot tokens (Telegram, Discord, Slack)", () => {
      const result = sanitizeEnvVars({
        TELEGRAM_BOT_TOKEN: "token123",
        DISCORD_BOT_TOKEN: "token456",
        SLACK_BOT_TOKEN: "xoxb-token",
      });
      expect(result.blocked).toHaveLength(3);
      expect(result.blocked.map((b) => b.key)).toContain("TELEGRAM_BOT_TOKEN");
      expect(result.blocked.map((b) => b.key)).toContain("DISCORD_BOT_TOKEN");
      expect(result.blocked.map((b) => b.key)).toContain("SLACK_BOT_TOKEN");
    });

    it("blocks database credentials", () => {
      const result = sanitizeEnvVars({
        DB_PASSWORD: "secret123",
        DATABASE_URL: "postgresql://user:pass@host/db",
        POSTGRES_PASSWORD: "pgpass",
      });
      expect(result.blocked).toHaveLength(3);
    });

    it("blocks cloud provider credentials (AWS, AZURE, GCP)", () => {
      const result = sanitizeEnvVars({
        AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
        AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        AZURE_CLIENT_SECRET: "secret",
        GCP_SERVICE_ACCOUNT_KEY: "key",
      });
      expect(result.blocked).toHaveLength(4);
    });

    it("blocks SSH and GPG keys", () => {
      const result = sanitizeEnvVars({
        SSH_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
        GPG_PASSPHRASE: "passphrase",
      });
      expect(result.blocked).toHaveLength(2);
    });

    it("blocks generic credential patterns (*_API_KEY, *_SECRET, *_PASSWORD, *_TOKEN)", () => {
      const result = sanitizeEnvVars({
        CUSTOM_API_KEY: "key123",
        MY_SECRET: "secret456",
        APP_PASSWORD: "pass789",
        SERVICE_TOKEN: "token000",
      });
      expect(result.blocked).toHaveLength(4);
    });
  });

  describe("allows safe environment variables", () => {
    it("allows locale and language variables", () => {
      const result = sanitizeEnvVars({
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        LC_CTYPE: "en_US.UTF-8",
      });
      expect(result.allowed).toEqual({
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        LC_CTYPE: "en_US.UTF-8",
      });
      expect(result.blocked).toHaveLength(0);
    });

    it("allows timezone variable", () => {
      const result = sanitizeEnvVars({ TZ: "America/New_York" });
      expect(result.allowed).toEqual({ TZ: "America/New_York" });
      expect(result.blocked).toHaveLength(0);
    });

    it("allows system variables (PATH, HOME, USER, SHELL)", () => {
      const result = sanitizeEnvVars({
        PATH: "/usr/bin:/bin",
        HOME: "/home/user",
        USER: "testuser",
        SHELL: "/bin/bash",
        TERM: "xterm-256color",
      });
      expect(Object.keys(result.allowed)).toHaveLength(5);
      expect(result.blocked).toHaveLength(0);
    });

    it("allows development variables (DEBUG, NODE_ENV, LOG_LEVEL)", () => {
      const result = sanitizeEnvVars({
        DEBUG: "true",
        NODE_ENV: "development",
        LOG_LEVEL: "info",
        WORKSPACE: "/workspace",
      });
      expect(Object.keys(result.allowed)).toHaveLength(4);
      expect(result.blocked).toHaveLength(0);
    });

    it("allows custom non-sensitive variables", () => {
      const result = sanitizeEnvVars({
        APP_NAME: "MyApp",
        PORT: "3000",
        ENABLE_FEATURE_X: "true",
      });
      expect(Object.keys(result.allowed)).toHaveLength(3);
      expect(result.blocked).toHaveLength(0);
    });
  });

  describe("mixed scenarios", () => {
    it("separates safe and sensitive variables", () => {
      const result = sanitizeEnvVars({
        NODE_ENV: "production",
        ANTHROPIC_API_KEY: "sk-ant-test",
        DEBUG: "false",
        DATABASE_URL: "postgresql://localhost/db",
        LOG_LEVEL: "warn",
      });
      expect(result.allowed).toEqual({
        NODE_ENV: "production",
        DEBUG: "false",
        LOG_LEVEL: "warn",
      });
      expect(result.blocked).toHaveLength(2);
      expect(result.blocked.map((b) => b.key)).toContain("ANTHROPIC_API_KEY");
      expect(result.blocked.map((b) => b.key)).toContain("DATABASE_URL");
    });
  });

  describe("strict mode", () => {
    it("in strict mode, blocks variables not in allowlist", () => {
      const result = sanitizeEnvVars(
        {
          NODE_ENV: "production", // In allowlist
          CUSTOM_VAR: "value", // Not in allowlist
        },
        { strictMode: true },
      );
      expect(result.allowed).toEqual({ NODE_ENV: "production" });
      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].key).toBe("CUSTOM_VAR");
      expect(result.blocked[0].reason).toContain("Not in allowlist");
    });

    it("in strict mode, still blocks sensitive variables even if in custom allowlist", () => {
      const result = sanitizeEnvVars(
        { ANTHROPIC_API_KEY: "sk-test" },
        {
          strictMode: true,
          customAllowedPatterns: [/^ANTHROPIC_API_KEY$/],
        },
      );
      // Blocklist takes precedence over allowlist
      expect(result.blocked).toHaveLength(1);
      expect(result.allowed).toEqual({});
    });
  });

  describe("custom patterns", () => {
    it("respects custom blocked patterns", () => {
      const result = sanitizeEnvVars(
        { MY_CUSTOM_KEY: "value" },
        {
          customBlockedPatterns: [/^MY_CUSTOM_KEY$/],
        },
      );
      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].key).toBe("MY_CUSTOM_KEY");
    });

    it("respects custom allowed patterns in strict mode", () => {
      const result = sanitizeEnvVars(
        { MY_CUSTOM_VAR: "value" },
        {
          strictMode: true,
          customAllowedPatterns: [/^MY_CUSTOM_VAR$/],
        },
      );
      expect(result.allowed).toEqual({ MY_CUSTOM_VAR: "value" });
      expect(result.blocked).toHaveLength(0);
    });
  });

  describe("value validation", () => {
    it("blocks values with null bytes", () => {
      const result = sanitizeEnvVars({ TEST_VAR: "value\0with\0nulls" });
      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].reason).toContain("null bytes");
    });

    it("blocks values exceeding 32KB", () => {
      const longValue = "a".repeat(33000);
      const result = sanitizeEnvVars({ TEST_VAR: longValue });
      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].reason).toContain("exceeds maximum length");
    });

    it("warns about suspicious base64-encoded values", () => {
      const base64Value = "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkw".repeat(3);
      const result = sanitizeEnvVars({ TEST_VAR: base64Value });
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("base64-encoded");
    });
  });

  describe("edge cases", () => {
    it("handles empty environment object", () => {
      const result = sanitizeEnvVars({});
      expect(result.allowed).toEqual({});
      expect(result.blocked).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("skips empty keys", () => {
      const result = sanitizeEnvVars({ "": "value", "  ": "value2" });
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("empty");
      expect(result.allowed).toEqual({});
    });

    it("handles case-insensitive matching for blocked patterns", () => {
      const result = sanitizeEnvVars({
        anthropic_api_key: "key1", // lowercase
        OPENAI_API_KEY: "key2", // uppercase
        OpenAI_API_KEY: "key3", // mixed case
      });
      expect(result.blocked).toHaveLength(3);
    });
  });

  describe("audit logging", () => {
    it("returns summary statistics", () => {
      const result = sanitizeEnvVars({
        NODE_ENV: "production",
        ANTHROPIC_API_KEY: "sk-test",
        DEBUG: "true",
        OPENAI_API_KEY: "sk-test2",
      });
      // Verify the result structure
      expect(typeof result).toBe("object");
      expect(Object.keys(result.allowed)).toHaveLength(2);
      expect(result.blocked).toHaveLength(2);
    });
  });
});

describe("getBlockedPatterns", () => {
  it("returns list of blocked pattern sources", () => {
    const patterns = getBlockedPatterns();
    expect(Array.isArray(patterns)).toBe(true);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.some((p) => p.includes("ANTHROPIC_API_KEY"))).toBe(true);
  });
});

describe("getAllowedPatterns", () => {
  it("returns list of allowed pattern sources", () => {
    const patterns = getAllowedPatterns();
    expect(Array.isArray(patterns)).toBe(true);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.some((p) => p.includes("LANG"))).toBe(true);
  });
});
