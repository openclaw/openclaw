import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Scout runtime config", () => {
  it("uses the first-class Scout home instead of the retired shared workspace path", () => {
    const scoutConfigPath = path.resolve(process.cwd(), "../../..", "config/agents/scout.json5");
    const scoutConfig = fs.readFileSync(scoutConfigPath, "utf8");

    expect(scoutConfig).toContain('"workspace": "/agent-homes/scout"');
    expect(scoutConfig).not.toContain("/shared-workspace/research/scout");
  });

  it("uses the async research service tool surface", () => {
    const scoutConfigPath = path.resolve(process.cwd(), "../../..", "config/agents/scout.json5");
    const scoutConfig = fs.readFileSync(scoutConfigPath, "utf8");

    expect(scoutConfig).toContain('"sessions_spawn"');
    expect(scoutConfig).toContain('"session_status"');
    expect(scoutConfig).toContain('"sessions_send"');
    expect(scoutConfig).toContain('"web_search"');
    expect(scoutConfig).toContain('"web_fetch"');
    expect(scoutConfig).toContain('"security": "allowlist"');
    expect(scoutConfig).toContain('"readWorkspaceOnly": false');
    expect(scoutConfig).toContain('"writeWorkspaceOnly": true');
    expect(scoutConfig).toContain('"editWorkspaceOnly": true');
    expect(scoutConfig).toContain('"write"');
    expect(scoutConfig).toContain('"edit"');
    expect(scoutConfig).toContain('"rg"');
    expect(scoutConfig).toContain('"find"');
    expect(scoutConfig).toContain('"git"');
    expect(scoutConfig).not.toContain('"sessions_list"');
    expect(scoutConfig).not.toContain('"sessions_history"');
  });
});
