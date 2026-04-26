import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { inferCapabilities } from "../src/agent-capabilities.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "orchestrator-caps-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeOptIn(agentId: string, capabilities: string[]): void {
  const dir = join(tmpRoot, agentId, "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "capabilities.json"), JSON.stringify({ capabilities }));
}

describe("inferCapabilities", () => {
  test("opt-in capabilities.json wins over fallback", () => {
    writeOptIn("coder", ["custom"]);
    expect(inferCapabilities("coder", { agentsDir: tmpRoot })).toEqual(["custom"]);
  });

  test("malformed capabilities.json falls back to inference", () => {
    const dir = join(tmpRoot, "coder", "agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "capabilities.json"), "{ not json");
    expect(inferCapabilities("coder", { agentsDir: tmpRoot })).toEqual(["code", "mutate-external"]);
  });

  test("exact-match table covers known specialists", () => {
    expect(inferCapabilities("coder", { agentsDir: tmpRoot })).toEqual(["code", "mutate-external"]);
    expect(inferCapabilities("helpdesk", { agentsDir: tmpRoot })).toEqual([
      "ops",
      "mutate-external",
    ]);
    expect(inferCapabilities("researcher", { agentsDir: tmpRoot })).toEqual(["research"]);
    expect(inferCapabilities("main", { agentsDir: tmpRoot })).toEqual([]);
  });

  test("prefix table catches mutate-external families", () => {
    expect(inferCapabilities("github-pr-author", { agentsDir: tmpRoot })).toEqual([
      "mutate-external",
      "code",
    ]);
    expect(inferCapabilities("gmail-replier", { agentsDir: tmpRoot })).toEqual([
      "mutate-external",
      "writing",
    ]);
    expect(inferCapabilities("linear-triage", { agentsDir: tmpRoot })).toEqual([
      "mutate-external",
      "ops",
    ]);
    expect(inferCapabilities("blog-publisher-bot", { agentsDir: tmpRoot })).toEqual([
      "publish",
      "ops",
    ]);
    expect(inferCapabilities("staging-deploy-runner", { agentsDir: tmpRoot })).toEqual([
      "publish",
      "ops",
    ]);
  });

  test("unknown agent gets an empty capability list", () => {
    expect(inferCapabilities("agents-foo-bar", { agentsDir: tmpRoot })).toEqual([]);
  });
});
