import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearInternalHooks } from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  applyContextInjectionFilter,
  resolveBootstrapContextForRun,
  sessionHasAssistantMessages,
} from "./bootstrap-files.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function makeFakeFiles(names: string[]): WorkspaceBootstrapFile[] {
  return names.map(
    (name) =>
      ({
        name,
        path: `/workspace/${name}`,
        content: `content of ${name}`,
        missing: false,
      }) as unknown as WorkspaceBootstrapFile,
  );
}

describe("applyContextInjectionFilter", () => {
  const files = makeFakeFiles(["AGENTS.md", "SOUL.md", "USER.md"]);

  it("always mode includes all files", () => {
    const result = applyContextInjectionFilter({
      files,
      contextInjection: "always",
      hasExistingAssistantMessages: true,
    });
    expect(result).toEqual(files);
  });

  it("always mode includes all files even with no history", () => {
    const result = applyContextInjectionFilter({
      files,
      contextInjection: "always",
      hasExistingAssistantMessages: false,
    });
    expect(result).toEqual(files);
  });

  it("first-message-only mode includes files when no assistant history", () => {
    const result = applyContextInjectionFilter({
      files,
      contextInjection: "first-message-only",
      hasExistingAssistantMessages: false,
    });
    expect(result).toEqual(files);
  });

  it("first-message-only mode excludes files when assistant history exists", () => {
    const result = applyContextInjectionFilter({
      files,
      contextInjection: "first-message-only",
      hasExistingAssistantMessages: true,
    });
    expect(result).toEqual([]);
  });

  it("undefined mode (default) behaves like always", () => {
    const result = applyContextInjectionFilter({
      files,
      contextInjection: undefined,
      hasExistingAssistantMessages: true,
    });
    expect(result).toEqual(files);
  });
});

describe("sessionHasAssistantMessages", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempWorkspace("openclaw-ctx-inject-");
  });

  it("returns false for nonexistent file", async () => {
    await expect(sessionHasAssistantMessages(path.join(tmpDir, "nonexistent.jsonl"))).resolves.toBe(
      false,
    );
  });

  it("returns false for empty file", async () => {
    const file = path.join(tmpDir, "empty.jsonl");
    await fs.writeFile(file, "", "utf8");
    await expect(sessionHasAssistantMessages(file)).resolves.toBe(false);
  });

  it("returns false when only user messages exist", async () => {
    const file = path.join(tmpDir, "user-only.jsonl");
    const lines = [
      JSON.stringify({ message: { role: "user", content: "hello" } }),
      JSON.stringify({ message: { role: "user", content: "world" } }),
    ].join("\n");
    await fs.writeFile(file, lines, "utf8");
    await expect(sessionHasAssistantMessages(file)).resolves.toBe(false);
  });

  it("returns true when assistant message exists", async () => {
    const file = path.join(tmpDir, "with-assistant.jsonl");
    const lines = [
      JSON.stringify({ message: { role: "user", content: "hello" } }),
      JSON.stringify({ message: { role: "assistant", content: "hi there" } }),
    ].join("\n");
    await fs.writeFile(file, lines, "utf8");
    await expect(sessionHasAssistantMessages(file)).resolves.toBe(true);
  });

  it("handles malformed lines gracefully", async () => {
    const file = path.join(tmpDir, "malformed.jsonl");
    const lines = [
      "not json at all",
      JSON.stringify({ message: { role: "assistant", content: "ok" } }),
    ].join("\n");
    await fs.writeFile(file, lines, "utf8");
    await expect(sessionHasAssistantMessages(file)).resolves.toBe(true);
  });
});

describe("resolveBootstrapContextForRun with contextInjection", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("first-message-only skips context files when hasExistingAssistantMessages is true", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-ctx-inject-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "agent instructions", "utf8");

    const result = await resolveBootstrapContextForRun({
      workspaceDir,
      contextInjection: "first-message-only",
      hasExistingAssistantMessages: true,
    });

    expect(result.contextFiles).toEqual([]);
  });

  it("first-message-only includes context files when hasExistingAssistantMessages is false", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-ctx-inject-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "agent instructions", "utf8");

    const result = await resolveBootstrapContextForRun({
      workspaceDir,
      contextInjection: "first-message-only",
      hasExistingAssistantMessages: false,
    });

    expect(result.contextFiles.length).toBeGreaterThan(0);
  });
});
