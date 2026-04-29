import { describe, expect, it, vi } from "vitest";
import { resolveChannelConfig, resolveConfig, resolveConnectorType } from "./config.js";

describe("resolveConfig", () => {
  it("returns defaults when no config provided", () => {
    const config = resolveConfig();
    expect(config.connector).toBe("");
    expect(config.http).toEqual({
      provider: "",
      apiKey: "",
      apiUrl: "",
      model: "omni-moderation-latest",
      params: {},
    });
    expect(config.import).toEqual({
      script: "",
      args: {},
      hot: false,
      hotDebounceMs: 300,
    });
    expect(config.timeoutMs).toBe(5000);
    expect(config.fallbackOnError).toBe("pass");
    expect(config.blockMessage).toBe("This request has been blocked by the guardrails policy.");
    expect(config.blacklist).toEqual({
      blacklistFile: false,
      caseSensitive: false,
      hot: false,
      hotDebounceMs: 300,
    });
    expect(config.channels).toEqual({});
  });

  it("resolves connector field", () => {
    expect(resolveConfig({ connector: "blacklist" }).connector).toBe("blacklist");
    expect(resolveConfig({ connector: "http" }).connector).toBe("http");
    expect(resolveConfig({ connector: "import" }).connector).toBe("import");
    expect(resolveConfig({ connector: "unknown" }).connector).toBe("");
    expect(resolveConfig({ connector: 42 }).connector).toBe("");
  });

  it("resolves timeoutMs", () => {
    expect(resolveConfig({ timeoutMs: 3000 }).timeoutMs).toBe(3000);
    expect(resolveConfig({ timeoutMs: "fast" }).timeoutMs).toBe(5000);
  });

  it("clamps timeoutMs to [500, 30000]", () => {
    expect(resolveConfig({ timeoutMs: 0 }).timeoutMs).toBe(500);
    expect(resolveConfig({ timeoutMs: -1 }).timeoutMs).toBe(500);
    expect(resolveConfig({ timeoutMs: 100 }).timeoutMs).toBe(500);
    expect(resolveConfig({ timeoutMs: 500 }).timeoutMs).toBe(500);
    expect(resolveConfig({ timeoutMs: 30000 }).timeoutMs).toBe(30000);
    expect(resolveConfig({ timeoutMs: 99999 }).timeoutMs).toBe(30000);
  });

  it("resolves fallbackOnError", () => {
    expect(resolveConfig({ fallbackOnError: "block" }).fallbackOnError).toBe("block");
    expect(resolveConfig({ fallbackOnError: "pass" }).fallbackOnError).toBe("pass");
    expect(resolveConfig({ fallbackOnError: "unknown" }).fallbackOnError).toBe("pass");
  });

  it("resolves blockMessage", () => {
    expect(resolveConfig({ blockMessage: "Custom block" }).blockMessage).toBe("Custom block");
    expect(resolveConfig({ blockMessage: 42 }).blockMessage).toBe(
      "This request has been blocked by the guardrails policy.",
    );
  });
});

describe("resolveConfig — import config", () => {
  it("resolves nested import object", () => {
    const config = resolveConfig({
      import: { script: "/opt/checker.ts", args: { key: "val" }, hot: true, hotDebounceMs: 500 },
    });
    expect(config.import.script).toBe("/opt/checker.ts");
    expect(config.import.args).toEqual({ key: "val" });
    expect(config.import.hot).toBe(true);
    expect(config.import.hotDebounceMs).toBe(500);
  });

  it("defaults import to empty when not provided", () => {
    const config = resolveConfig({});
    expect(config.import).toEqual({ script: "", args: {}, hot: false, hotDebounceMs: 300 });
  });
});

describe("resolveConfig — http sub-config", () => {
  it("resolves http with all fields", () => {
    const config = resolveConfig({
      http: {
        provider: "openai-moderation",
        apiKey: "sk-xxx",
        apiUrl: "https://api.custom.com",
        model: "text-moderation-stable",
        params: { project_id: "proj-1" },
      },
    });
    expect(config.http.provider).toBe("openai-moderation");
    expect(config.http.apiKey).toBe("sk-xxx");
    expect(config.http.apiUrl).toBe("https://api.custom.com");
    expect(config.http.model).toBe("text-moderation-stable");
    expect(config.http.params).toEqual({ project_id: "proj-1" });
  });

  it("accepts open-string provider names (registry extensible)", () => {
    expect(resolveConfig({ http: { provider: "custom-provider" } }).http.provider).toBe(
      "custom-provider",
    );
    expect(resolveConfig({ http: { provider: 42 } }).http.provider).toBe("");
  });

  it("resolves dknownai provider", () => {
    expect(resolveConfig({ http: { provider: "dknownai" } }).http.provider).toBe("dknownai");
  });

  it("defaults model to omni-moderation-latest", () => {
    expect(resolveConfig({ http: {} }).http.model).toBe("omni-moderation-latest");
  });

  it("defaults http to empty when invalid", () => {
    const config = resolveConfig({ http: "string" });
    expect(config.http.provider).toBe("");
    expect(config.http.apiKey).toBe("");
    expect(config.http.apiUrl).toBe("");
  });
});

describe("resolveConfig — blacklist sub-config", () => {
  it("resolves blacklist config fields", () => {
    const config = resolveConfig({
      blacklist: { blacklistFile: true, caseSensitive: true },
    });
    expect(config.blacklist.blacklistFile).toBe(true);
    expect(config.blacklist.caseSensitive).toBe(true);
  });

  it("resolves blacklistFile: true", () => {
    expect(resolveConfig({ blacklist: { blacklistFile: true } }).blacklist.blacklistFile).toBe(
      true,
    );
  });

  it("resolves blacklistFile as string path", () => {
    expect(
      resolveConfig({ blacklist: { blacklistFile: "/etc/kw.txt" } }).blacklist.blacklistFile,
    ).toBe("/etc/kw.txt");
  });

  it("resolves blacklistFile to false for invalid values", () => {
    expect(resolveConfig({ blacklist: { blacklistFile: 42 } }).blacklist.blacklistFile).toBe(false);
    expect(resolveConfig({ blacklist: { blacklistFile: "" } }).blacklist.blacklistFile).toBe(false);
    expect(resolveConfig({ blacklist: { blacklistFile: false } }).blacklist.blacklistFile).toBe(
      false,
    );
  });

  it("resolves blacklist hot and hotDebounceMs", () => {
    const config = resolveConfig({ blacklist: { hot: true, hotDebounceMs: 500 } });
    expect(config.blacklist.hot).toBe(true);
    expect(config.blacklist.hotDebounceMs).toBe(500);
  });

  it("defaults blacklist to empty when invalid", () => {
    const defaults = {
      blacklistFile: false,
      caseSensitive: false,
      hot: false,
      hotDebounceMs: 300,
    };
    expect(resolveConfig({ blacklist: "string" }).blacklist).toEqual(defaults);
    expect(resolveConfig({ blacklist: null }).blacklist).toEqual(defaults);
  });
});

describe("resolveConfig — channels", () => {
  it("resolves empty channels", () => {
    expect(resolveConfig({ channels: {} }).channels).toEqual({});
  });

  it("resolves channels with connector override", () => {
    const config = resolveConfig({
      channels: { discord: { connector: "blacklist" } },
    });
    expect(config.channels.discord.connector).toBe("blacklist");
  });

  it("resolves channels with import connector", () => {
    const config = resolveConfig({
      channels: { webchat: { connector: "import" } },
    });
    expect(config.channels.webchat.connector).toBe("import");
  });

  it("resolves channels with http override", () => {
    const config = resolveConfig({
      channels: {
        telegram: {
          http: { provider: "dknownai", apiKey: "lk-xxx" },
        },
      },
    });
    expect(config.channels.telegram.http?.provider).toBe("dknownai");
    expect(config.channels.telegram.http?.apiKey).toBe("lk-xxx");
  });

  it("resolves channels with blacklist override", () => {
    const config = resolveConfig({
      channels: {
        discord: {
          blacklist: { blacklistFile: "/custom/kw.txt", caseSensitive: true },
        },
      },
    });
    expect(config.channels.discord.blacklist?.blacklistFile).toBe("/custom/kw.txt");
    expect(config.channels.discord.blacklist?.caseSensitive).toBe(true);
  });

  it("resolves channels with import override", () => {
    const config = resolveConfig({
      channels: {
        webchat: {
          import: { script: "/opt/private.ts", args: { key: "val" } },
        },
      },
    });
    expect(config.channels.webchat.import?.script).toBe("/opt/private.ts");
    expect(config.channels.webchat.import?.args).toEqual({ key: "val" });
  });

  it("resolves channels with scalar overrides", () => {
    const config = resolveConfig({
      channels: {
        slack: {
          blockMessage: "Blocked!",
          fallbackOnError: "block",
          timeoutMs: 3000,
        },
      },
    });
    expect(config.channels.slack.blockMessage).toBe("Blocked!");
    expect(config.channels.slack.fallbackOnError).toBe("block");
    expect(config.channels.slack.timeoutMs).toBe(3000);
  });

  it("clamps channel timeoutMs", () => {
    const config = resolveConfig({
      channels: { test: { timeoutMs: 100 } },
    });
    expect(config.channels.test.timeoutMs).toBe(500);
  });

  it("ignores invalid channels entries", () => {
    const config = resolveConfig({
      channels: { valid: { connector: "http" }, invalid: "string", also_invalid: null },
    });
    expect(Object.keys(config.channels)).toEqual(["valid"]);
  });

  it("defaults channels to empty for invalid value", () => {
    expect(resolveConfig({ channels: "string" }).channels).toEqual({});
    expect(resolveConfig({ channels: null }).channels).toEqual({});
  });
});

describe("resolveConnectorType", () => {
  it("returns explicit connector when set", () => {
    const config = resolveConfig({ connector: "http" });
    expect(resolveConnectorType(config)).toBe("http");
  });

  it("auto-detects http from http.provider", () => {
    const config = resolveConfig({ http: { provider: "openai-moderation" } });
    expect(resolveConnectorType(config)).toBe("http");
  });

  it("auto-detects http from http.apiUrl", () => {
    const config = resolveConfig({ http: { apiUrl: "https://example.com" } });
    expect(resolveConnectorType(config)).toBe("http");
  });

  it("auto-detects import from import.script", () => {
    const config = resolveConfig({ import: { script: "/tmp/checker.ts" } });
    expect(resolveConnectorType(config)).toBe("import");
  });

  it("auto-detects blacklist from blacklistFile=true", () => {
    const config = resolveConfig({ blacklist: { blacklistFile: true } });
    expect(resolveConnectorType(config)).toBe("blacklist");
  });

  it("auto-detects blacklist from explicit file path string", () => {
    const config = resolveConfig({ blacklist: { blacklistFile: "/etc/kw.txt" } });
    expect(resolveConnectorType(config)).toBe("blacklist");
  });

  it("auto-detect priority: http > import > blacklist", () => {
    const config = resolveConfig({
      http: { apiUrl: "https://example.com" },
      import: { script: "/tmp/checker.ts" },
      blacklist: { blacklistFile: true },
    });
    expect(resolveConnectorType(config)).toBe("http");
  });

  it("returns null when nothing configured", () => {
    const config = resolveConfig({});
    expect(resolveConnectorType(config)).toBeNull();
  });

  it("explicit connector overrides auto-detection", () => {
    const config = resolveConfig({
      connector: "blacklist",
      http: { apiUrl: "https://example.com" },
      blacklist: { blacklistFile: true },
    });
    expect(resolveConnectorType(config)).toBe("blacklist");
  });
});

describe("resolveChannelConfig", () => {
  it.each([
    ["no channelId", undefined],
    ["unknown channelId", "unknown"],
    ["empty channelId", ""],
  ])("returns global defaults when %s", (_label, channelId) => {
    const global = resolveConfig({
      connector: "http",
      http: { apiUrl: "https://api.com" },
      channels: {},
    });
    const effective = resolveChannelConfig(global, channelId);
    expect(effective.connector).toBe("http");
    expect(effective.enabled).toBe(true);
  });

  it("returns enabled=false when no global connector and no channel override", () => {
    const global = resolveConfig({});
    const effective = resolveChannelConfig(global, undefined);
    expect(effective.enabled).toBe(false);
    expect(effective.connector).toBeNull();
  });

  it("overrides connector at channel level", () => {
    const global = resolveConfig({
      connector: "http",
      channels: { webchat: { connector: "blacklist" } },
    });
    const effective = resolveChannelConfig(global, "webchat");
    expect(effective.connector).toBe("blacklist");
    expect(effective.enabled).toBe(true);
  });

  it("channel can enable when global has no connector", () => {
    const global = resolveConfig({
      channels: {
        webchat: { connector: "http" },
      },
    });
    const globalEffective = resolveChannelConfig(global, undefined);
    expect(globalEffective.enabled).toBe(false);

    const channelEffective = resolveChannelConfig(global, "webchat");
    expect(channelEffective.enabled).toBe(true);
    expect(channelEffective.connector).toBe("http");
  });

  it("channel can use import connector", () => {
    const global = resolveConfig({
      connector: "http",
      channels: { internal: { connector: "import" } },
    });
    const effective = resolveChannelConfig(global, "internal");
    expect(effective.connector).toBe("import");
    expect(effective.enabled).toBe(true);
  });

  it("overrides http fields at channel level", () => {
    const global = resolveConfig({
      http: {
        provider: "openai-moderation",
        apiKey: "sk-global",
        apiUrl: "https://api.openai.com",
      },
    });
    const effective = resolveChannelConfig(
      { ...global, channels: { telegram: { http: { provider: "dknownai", apiKey: "lk-xxx" } } } },
      "telegram",
    );
    expect(effective.http.provider).toBe("dknownai");
    expect(effective.http.apiKey).toBe("lk-xxx");
    expect(effective.http.apiUrl).toBe("https://api.openai.com"); // not overridden
  });

  it("overrides blacklist fields at channel level", () => {
    const global = resolveConfig({
      connector: "blacklist",
      blacklist: { blacklistFile: true, caseSensitive: false },
      channels: {
        discord: { blacklist: { caseSensitive: true } },
      },
    });
    const effective = resolveChannelConfig(global, "discord");
    expect(effective.blacklist.caseSensitive).toBe(true);
    expect(effective.blacklist.blacklistFile).toBe(true); // inherited
  });

  it("overrides import fields at channel level", () => {
    const global = resolveConfig({
      connector: "import",
      import: { script: "/opt/default.ts", args: { a: 1 } },
      channels: {
        webchat: { import: { script: "/opt/webchat.ts" } },
      },
    });
    const effective = resolveChannelConfig(global, "webchat");
    expect(effective.import.script).toBe("/opt/webchat.ts");
    expect(effective.import.args).toEqual({ a: 1 }); // inherited
  });

  it("overrides scalar fields at channel level", () => {
    const global = resolveConfig({
      connector: "http",
      blockMessage: "Global block",
      fallbackOnError: "pass",
      timeoutMs: 5000,
      channels: {
        slack: {
          blockMessage: "Slack block",
          fallbackOnError: "block",
          timeoutMs: 3000,
        },
      },
    });
    const effective = resolveChannelConfig(global, "slack");
    expect(effective.blockMessage).toBe("Slack block");
    expect(effective.fallbackOnError).toBe("block");
    expect(effective.timeoutMs).toBe(3000);
  });

  it("warns when http provider/apiUrl overridden without apiKey", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const global = resolveConfig({
      http: { provider: "openai-moderation", apiKey: "sk-openai" },
      channels: {
        telegram: { http: { provider: "dknownai", apiUrl: "https://guard.example.com" } },
      },
    });
    resolveChannelConfig(global, "telegram", logger);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("apiKey"));
  });

  it("does NOT inherit global apiKey when channel changes provider without apiKey", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const global = resolveConfig({
      http: { provider: "openai-moderation", apiKey: "sk-openai" },
      channels: {
        telegram: { http: { provider: "dknownai", apiUrl: "https://guard.example.com" } },
      },
    });
    const effective = resolveChannelConfig(global, "telegram", logger);
    expect(effective.http.apiKey).toBe("");
  });

  it("does NOT inherit global apiKey when channel only overrides apiUrl", () => {
    const global = resolveConfig({
      http: { provider: "openai-moderation", apiKey: "sk-openai" },
      channels: {
        telegram: { http: { apiUrl: "https://relay.example.com" } },
      },
    });
    const effective = resolveChannelConfig(global, "telegram");
    expect(effective.http.apiKey).toBe("");
  });

  it("preserves global apiKey when channel only overrides model (no provider/apiUrl change)", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const global = resolveConfig({
      http: { provider: "openai-moderation", apiKey: "sk-openai" },
      channels: {
        slack: { http: { model: "text-moderation-latest" } },
      },
    });
    const effective = resolveChannelConfig(global, "slack", logger);
    expect(effective.http.apiKey).toBe("sk-openai");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not warn when apiKey is also overridden", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const global = resolveConfig({
      http: { provider: "openai-moderation", apiKey: "sk-openai" },
      channels: { telegram: { http: { provider: "dknownai", apiKey: "lk-xxx" } } },
    });
    resolveChannelConfig(global, "telegram", logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not warn when global has no apiKey", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const global = resolveConfig({
      http: { provider: "openai-moderation" },
      channels: { telegram: { http: { provider: "dknownai" } } },
    });
    resolveChannelConfig(global, "telegram", logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
