import { beforeAll, describe, expect, it } from "vitest";

let buildTelegramPluginStatusMessage: typeof import("./plugin-status-message.js").buildTelegramPluginStatusMessage;
let isPluginCommand: typeof import("./plugin-status-message.js").isPluginCommand;
let escapeMarkdown: typeof import("./plugin-status-message.js").escapeMarkdown;
let normalizeTelegramSlashCommand: typeof import("./plugin-status-message.js").normalizeTelegramSlashCommand;
let MCP_STATUS_COMMANDS: typeof import("./plugin-status-message.js").MCP_STATUS_COMMANDS;
let TELEGRAM_MCP_PLUGIN_MANIFESTS: typeof import("./mcp-plugin-manifest.js").TELEGRAM_MCP_PLUGIN_MANIFESTS;

describe("plugin status message builder", () => {
  beforeAll(async () => {
    ({
      buildTelegramPluginStatusMessage,
      isPluginCommand,
      escapeMarkdown,
      normalizeTelegramSlashCommand,
      MCP_STATUS_COMMANDS,
    } = await import("./plugin-status-message.js"));
    ({ TELEGRAM_MCP_PLUGIN_MANIFESTS } = await import("./mcp-plugin-manifest.js"));
  });

  it("output contains all manifest plugin ids", () => {
    const output = buildTelegramPluginStatusMessage();
    for (const manifest of TELEGRAM_MCP_PLUGIN_MANIFESTS) {
      // Use escaped version since output uses Telegram MarkdownV2 escaping
      expect(output).toContain(escapeMarkdown(manifest.id));
    }
  });

  it("output contains selected-only / catalog policy", () => {
    const output = buildTelegramPluginStatusMessage();
    const selectedOnlyCount = TELEGRAM_MCP_PLUGIN_MANIFESTS.filter(
      (m) => m.catalogPolicy === "selected_only",
    ).length;
    // All plugins currently use selected_only
    expect(selectedOnlyCount).toBe(TELEGRAM_MCP_PLUGIN_MANIFESTS.length);
    expect(output).toContain("selected_only");
  });

  it("output contains auto-call off", () => {
    const output = buildTelegramPluginStatusMessage();
    expect(output).toContain("auto-call: off");
  });

  it("output contains read-only / default mode", () => {
    const output = buildTelegramPluginStatusMessage();
    const readOnlyCount = TELEGRAM_MCP_PLUGIN_MANIFESTS.filter(
      (m) => m.defaultMode === "read_only",
    ).length;
    expect(readOnlyCount).toBe(TELEGRAM_MCP_PLUGIN_MANIFESTS.length);
    expect(output).toContain("read_only");
  });

  it("output contains approval-required summary", () => {
    const output = buildTelegramPluginStatusMessage();
    expect(output).toContain("approval required");
    expect(output).toContain("write/send/delete/costly/private_data/secret_access");
  });

  it("output contains deny summary", () => {
    const output = buildTelegramPluginStatusMessage();
    expect(output).toContain("denied");
    expect(output).toContain("financial_execution/destructive");
  });

  it("output contains no secret, token, key, env, or path strings", () => {
    const output = buildTelegramPluginStatusMessage();
    const sensitivePatterns = ["secret", "token", "api_key", "env", "path", "pid", "process"];
    for (const pattern of sensitivePatterns) {
      // "private/secret" is a capability label, so exclude "secret" in that exact phrase
      if (pattern === "secret") {
        // Verify the only "secret" mentions are in the capability summary
        const secretLines = output.split("\n").filter((l) => l.toLowerCase().includes("secret"));
        for (const line of secretLines) {
          expect(line).toMatch(/private.*secret|secret.*access/i);
        }
        continue;
      }
      expect(output.toLowerCase()).not.toContain(pattern);
    }
  });

  it("output length is under Telegram safe limit (4000 chars)", () => {
    const output = buildTelegramPluginStatusMessage();
    expect(output.length).toBeLessThan(4000);
  });

  it("output title is MCP Plugins", () => {
    const output = buildTelegramPluginStatusMessage();
    expect(output.startsWith("🧩 **MCP Plugins**")).toBe(true);
  });

  it("output includes MCP vs full registry explanation", () => {
    const output = buildTelegramPluginStatusMessage();
    expect(output).toContain("Telegram MCP 트리거용");
    expect(output).toContain("/plugins");
  });
});

describe("normalizeTelegramSlashCommand", () => {
  it("strips @botname suffix", () => {
    expect(normalizeTelegramSlashCommand("/mcp_status@jinhee_openclaw_bot")).toBe("/mcp_status");
    expect(normalizeTelegramSlashCommand("/mcp_plugins@some_bot")).toBe("/mcp_plugins");
  });

  it("handles plain commands without @", () => {
    expect(normalizeTelegramSlashCommand("/mcp_status")).toBe("/mcp_status");
    expect(normalizeTelegramSlashCommand("  /mcp_plugins  ")).toBe("/mcp_plugins");
  });

  it("handles commands with arguments", () => {
    expect(normalizeTelegramSlashCommand("/mcp_status arg")).toBe("/mcp_status");
    expect(normalizeTelegramSlashCommand("/mcp_status@bot arg val")).toBe("/mcp_status");
  });

  it("lowercases the command", () => {
    expect(normalizeTelegramSlashCommand("/MCP_STATUS")).toBe("/mcp_status");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeTelegramSlashCommand("")).toBe("");
  });
});

describe("isPluginCommand (MCP status)", () => {
  it("detects /mcp_status", () => {
    expect(isPluginCommand("/mcp_status")).toBe(true);
    expect(isPluginCommand("  /mcp_status  ")).toBe(true);
  });

  it("detects /mcp_plugins", () => {
    expect(isPluginCommand("/mcp_plugins")).toBe(true);
    expect(isPluginCommand("  /mcp_plugins  ")).toBe(true);
  });

  it("detects /plugin_status (backward compat)", () => {
    expect(isPluginCommand("/plugin_status")).toBe(true);
    expect(isPluginCommand("  /plugin_status  ")).toBe(true);
  });

  it("detects /mcp_status@botname", () => {
    expect(isPluginCommand("/mcp_status@jinhee_openclaw_bot")).toBe(true);
    expect(isPluginCommand("/mcp_plugins@some_bot arg")).toBe(true);
  });

  it("does NOT detect /plugins (now handled by OpenClaw main registry)", () => {
    expect(isPluginCommand("/plugins")).toBe(false);
    expect(isPluginCommand("  /plugins  ")).toBe(false);
    expect(isPluginCommand("/plugins something")).toBe(false);
  });

  it("returns false for unrelated commands", () => {
    expect(isPluginCommand("/start")).toBe(false);
    expect(isPluginCommand("/models")).toBe(false);
    expect(isPluginCommand("안녕")).toBe(false);
    expect(isPluginCommand("github 상태 확인")).toBe(false);
    expect(isPluginCommand("")).toBe(false);
  });

  it("has three commands in MCP_STATUS_COMMANDS", () => {
    expect(MCP_STATUS_COMMANDS.has("/mcp_status")).toBe(true);
    expect(MCP_STATUS_COMMANDS.has("/mcp_plugins")).toBe(true);
    expect(MCP_STATUS_COMMANDS.has("/plugin_status")).toBe(true);
    expect(MCP_STATUS_COMMANDS.size).toBe(3);
  });
});
