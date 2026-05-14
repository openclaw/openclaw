import { describe, expect, it } from "vitest";
import { buildClaudeTmuxManagedSettings, parseHookEventLine } from "./hooks.js";

describe("buildClaudeTmuxManagedSettings", () => {
  it("enables managed-only hooks and memory disable settings", () => {
    const settings = buildClaudeTmuxManagedSettings({
      rootDir: "/tmp/root",
      activeRunFile: "/tmp/root/active-run.json",
      eventsFile: "/tmp/root/events.jsonl",
      paneLogFile: "/tmp/root/pane.log",
      launcherFile: "/tmp/root/launch-claude.mjs",
      managedSettingsFile: "/tmp/root/managed-settings.json",
      settingsFile: "/tmp/root/settings.json",
      systemPromptFile: "/tmp/root/system.txt",
      hookWriterFile: "/tmp/root/hook-writer.mjs",
      promptBufferFile: "/tmp/root/prompt.txt",
      metadataFile: "/tmp/root/metadata.json",
    });

    expect(settings).toMatchObject({
      autoMemoryEnabled: false,
      autoDreamEnabled: false,
      allowManagedHooksOnly: true,
    });
    expect(JSON.stringify(settings)).toContain("Stop");
    expect(JSON.stringify(settings)).toContain("hook-writer.mjs");
  });
});

describe("parseHookEventLine", () => {
  it("parses known hook event JSONL records", () => {
    expect(
      parseHookEventLine(
        JSON.stringify({
          event: "Stop",
          runId: "run",
          timestamp: 123,
          stdin: { session_id: "claude-session" },
        }),
      ),
    ).toEqual({
      event: "Stop",
      runId: "run",
      timestamp: 123,
      stdin: { session_id: "claude-session" },
    });
  });

  it("ignores malformed or unknown event lines", () => {
    expect(parseHookEventLine("{")).toBeNull();
    expect(parseHookEventLine(JSON.stringify({ event: "Unknown", timestamp: 1 }))).toBeNull();
  });
});
