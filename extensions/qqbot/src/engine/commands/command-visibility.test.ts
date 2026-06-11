// Qqbot tests cover group command visibility classification.
import { describe, expect, it } from "vitest";
import { classifyCoreCommandForGroup, parseSlashCommandName } from "./command-visibility.js";

describe("QQBot command visibility", () => {
  it("parses slash command names case-insensitively", () => {
    expect(parseSlashCommandName(" /NEW now ")).toBe("new");
    expect(parseSlashCommandName("/CONFIG: show")).toBe("config");
    expect(parseSlashCommandName("/config：show")).toBe("config");
    expect(parseSlashCommandName("/config@bot show")).toBe("config");
    expect(parseSlashCommandName("hello")).toBeUndefined();
  });

  it("keeps safe collaboration commands visible in groups", () => {
    for (const command of ["/help", "/btw side question", "/stop"]) {
      expect(classifyCoreCommandForGroup(command).visibility).toBe("group");
    }
  });

  it("keeps group-session controls callable but hidden from group menus", () => {
    for (const command of ["/new", "/reset", "/compact"]) {
      expect(classifyCoreCommandForGroup(command).visibility).toBe("hidden");
    }
  });

  it("marks sensitive core commands as private-only in groups", () => {
    for (const command of [
      "/config",
      "/bash",
      "/export-session",
      "/diagnostics",
      "/tts",
      "/steer",
      "/tell",
      "/model",
      "/models",
      "/status",
      "/verbose",
      "/v",
      "/config: show",
      "/model@bot sonnet",
    ]) {
      expect(classifyCoreCommandForGroup(command).visibility).toBe("private");
    }
  });

  it("allows every recognized core command in all mode", () => {
    for (const command of ["/config", "/bash", "/new", "/status"]) {
      expect(classifyCoreCommandForGroup(command, "all").visibility).not.toBe("private");
    }
  });

  it("only allows reset/new core commands in strict mode", () => {
    expect(classifyCoreCommandForGroup("/new", "strict").visibility).toBe("hidden");
    expect(classifyCoreCommandForGroup("/reset", "strict").visibility).toBe("hidden");
    expect(classifyCoreCommandForGroup("/status", "strict").visibility).toBe("private");
    expect(classifyCoreCommandForGroup("/config", "strict").visibility).toBe("private");
  });

  it("leaves plugin and unknown slash commands to their existing dispatch path", () => {
    expect(classifyCoreCommandForGroup("/bot-help").visibility).toBe("unknown");
    expect(classifyCoreCommandForGroup("/unknown").visibility).toBe("unknown");
  });
});
