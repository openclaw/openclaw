import { describe, expect, it } from "vitest";
import {
  handleCodexPluginsSubcommand,
  type CodexPluginConfigEntry,
  type CodexPluginsManagementIO,
} from "./command-plugins-management.js";

function inMemoryIO(
  initial: Record<string, CodexPluginConfigEntry> = {},
): CodexPluginsManagementIO & {
  current: () => Record<string, CodexPluginConfigEntry>;
} {
  const store: Record<string, CodexPluginConfigEntry> = JSON.parse(JSON.stringify(initial));
  return {
    current: () => JSON.parse(JSON.stringify(store)),
    readConfig: () => Promise.resolve({ plugins: JSON.parse(JSON.stringify(store)) }),
    mutate: async (update) => {
      update(store);
    },
  };
}

const fakeCtx = {
  args: "",
  config: {},
} as never;

describe("Codex /codex plugins subcommand", () => {
  it("lists configured plugins with on or off markers and explains the underlying file", async () => {
    const io = inMemoryIO({
      chrome: { enabled: true, marketplaceName: "openai-bundled", pluginName: "chrome" },
      documents: {
        enabled: false,
        marketplaceName: "openai-primary-runtime",
        pluginName: "documents",
      },
    });

    const result = await handleCodexPluginsSubcommand(fakeCtx, ["list"], io);
    expect(result.text).toContain("ON   chrome");
    expect(result.text).toContain("OFF  documents");
    expect(result.text).toContain("openclaw.json");
  });

  it("enables and disables a configured plugin and reflects the change in subsequent reads", async () => {
    const io = inMemoryIO({
      chrome: { enabled: true, marketplaceName: "openai-bundled", pluginName: "chrome" },
    });

    const disabled = await handleCodexPluginsSubcommand(fakeCtx, ["disable", "chrome"], io);
    expect(disabled.text).toContain("disabled");
    expect(io.current().chrome.enabled).toBe(false);

    const enabled = await handleCodexPluginsSubcommand(fakeCtx, ["enable", "chrome"], io);
    expect(enabled.text).toContain("enabled");
    expect(io.current().chrome.enabled).toBe(true);
  });

  it("escapes configured plugin fields before listing them in chat", async () => {
    const io = inMemoryIO({
      "plugin_@team": {
        enabled: true,
        marketplaceName: "market[`place`]",
        pluginName: "plugin_*name*",
      },
    });

    const result = await handleCodexPluginsSubcommand(fakeCtx, ["list"], io);
    expect(result.text).toContain("plugin＿＠team");
    expect(result.text).toContain("plugin＿∗name∗");
    expect(result.text).toContain("market［｀place｀］");
    expect(result.text).not.toContain("@team");
    expect(result.text).not.toContain("*name*");
    expect(result.text).not.toContain("[`place`]");
  });

  it("reports when a target plugin is not configured rather than silently no-oping", async () => {
    const io = inMemoryIO();
    const result = await handleCodexPluginsSubcommand(fakeCtx, ["disable", "chrome_@ops"], io);
    expect(result.text).toContain("not configured");
    expect(result.text).toContain("chrome＿＠ops");
    expect(result.text).not.toContain("@ops");
  });

  it("returns usage when list, enable, or disable receives the wrong arity", async () => {
    const io = inMemoryIO();
    const listResult = await handleCodexPluginsSubcommand(fakeCtx, ["list", "chrome"], io);
    expect(listResult.text).toContain("Usage: /codex plugins list");

    const result = await handleCodexPluginsSubcommand(fakeCtx, ["disable"], io);
    expect(result.text).toContain("Usage: /codex plugins disable <name>");
    expect(result.presentation).toBeUndefined();

    const enableResult = await handleCodexPluginsSubcommand(fakeCtx, ["enable"], io);
    expect(enableResult.text).toContain("Usage: /codex plugins enable <name>");
    expect(enableResult.presentation).toBeUndefined();

    const extraResult = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["enable", "chrome", "extra"],
      io,
    );
    expect(extraResult.text).toContain("Usage: /codex plugins enable <name>");
  });

  it("unknown subcommands list only the supported verbs", async () => {
    const io = inMemoryIO();
    const result = await handleCodexPluginsSubcommand(fakeCtx, ["help"], io);
    expect(result.text).toContain("Unknown /codex plugins subcommand: help");
    expect(result.text).toContain("/codex plugins enable");
    expect(result.text).toContain("/codex plugins disable");
    expect(result.text).toContain("/codex plugins list");
    expect(result.text).not.toContain("/codex plugins toggle");
    expect(result.text).not.toContain("/codex plugins remove");
    expect(result.text).not.toContain("/codex plugins add");
    expect(result.text).not.toContain("/codex plugins help");
    expect(result.text).not.toContain("/codex plugins menu");
    expect(result.text).toContain("openclaw.json");
    expect(result.text).toContain("never to ~/.codex/config.toml");
  });
});
