import fs, { mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { readSettingsScope } from "./settings-storage.js";

const fixtures = createFixtureLifetime();

function settingsFixture(label: string, initial?: string) {
  const root = fixtures.createTempDir(`openclaw-settings-${label}-`);
  const agentDir = join(root, "agent");
  const settingsPath = join(agentDir, "settings.json");
  if (initial !== undefined) {
    mkdirSync(agentDir);
    fs.writeFileSync(settingsPath, initial);
  }
  return { root, agentDir, settingsPath };
}

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await fixtures.cleanup();
});

it.each([
  { input: "{" },
  { input: "null" },
  { input: "42" },
  { input: "true" },
  { input: '"invalid"' },
])("isolates invalid settings $input to the affected file", ({ input }) => {
  const { root, settingsPath } = settingsFixture("invalid", input);
  const projectPath = join(root, ".openclaw", "settings.json");
  mkdirSync(join(root, ".openclaw"));
  fs.writeFileSync(projectPath, '{"defaultThinkingLevel":"high"}');
  expect(readSettingsScope(settingsPath)).toEqual({});
  expect(readSettingsScope(projectPath)).toEqual({ defaultThinkingLevel: "high" });
  expect(fs.readFileSync(settingsPath, "utf8")).toBe(input);
});

it.each(["EISDIR", "ENOTDIR"])(
  "isolates a file %s error without losing the other scope",
  (code) => {
    const { root, agentDir, settingsPath } = settingsFixture("read-error");
    if (code === "EISDIR") {
      mkdirSync(settingsPath, { recursive: true });
    } else {
      fs.writeFileSync(agentDir, "not a directory");
    }
    const projectPath = join(root, ".openclaw", "settings.json");
    mkdirSync(join(root, ".openclaw"));
    fs.writeFileSync(projectPath, '{"defaultThinkingLevel":"high"}');
    expect(readSettingsScope(settingsPath)).toEqual({});
    expect(readSettingsScope(projectPath)).toEqual({ defaultThinkingLevel: "high" });
  },
);

it("loads absent settings without creating or syncing writer sidecars", () => {
  const { root, agentDir, settingsPath } = settingsFixture("unlocked");
  mkdirSync(agentDir);
  mkdirSync(join(root, ".openclaw"));
  const fsync = vi.spyOn(fs, "fsyncSync");
  syncBuiltinESMExports();
  expect(readSettingsScope(settingsPath)).toEqual({});
  expect(readSettingsScope(join(root, ".openclaw", "settings.json"))).toEqual({});
  expect(fsync).not.toHaveBeenCalled();
  expect(fs.readdirSync(agentDir)).toEqual([]);
  expect(fs.readdirSync(join(root, ".openclaw"))).toEqual([]);
});
