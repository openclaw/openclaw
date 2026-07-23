import { describe, expect, it } from "vitest";
import { isMutatingNativeToolItem } from "./event-projector-items.js";
import type { CodexThreadItem } from "./protocol.js";

function commandItem(command: string): CodexThreadItem {
  return {
    id: "cmd-1",
    type: "commandExecution",
    title: "Command",
    status: "completed",
    name: null,
    tool: null,
    server: null,
    command,
    cwd: "/workspace",
    query: null,
    aggregatedOutput: null,
    text: "",
    changes: [],
    exitCode: 0,
    durationMs: 1,
    commandActions: [],
  };
}

describe("isMutatingNativeToolItem", () => {
  it("classifies proven read-only shell inspection as non-mutating (#101890)", () => {
    expect(isMutatingNativeToolItem(commandItem("rg TODO src"))).toBe(false);
    expect(isMutatingNativeToolItem(commandItem("ls -la"))).toBe(false);
    expect(isMutatingNativeToolItem(commandItem("cat package.json"))).toBe(false);
  });

  it("keeps mutating, ambiguous, and unknown commandExecution fail-closed", () => {
    expect(isMutatingNativeToolItem(commandItem("npm install"))).toBe(true);
    expect(isMutatingNativeToolItem(commandItem("rm -rf /tmp/x"))).toBe(true);
    expect(isMutatingNativeToolItem(commandItem(""))).toBe(true);
    expect(
      isMutatingNativeToolItem({
        id: "patch-1",
        type: "fileChange",
        title: "File change",
        status: "completed",
        name: null,
        tool: null,
        server: null,
        command: null,
        cwd: null,
        query: null,
        aggregatedOutput: null,
        text: "",
        changes: [],
      }),
    ).toBe(true);
  });

  it("ignores commandActions presentation hints for mutation classification", () => {
    const item = {
      ...commandItem("npm publish"),
      commandActions: [{ type: "search", query: "npm publish" }],
    };
    expect(isMutatingNativeToolItem(item)).toBe(true);
  });
});
