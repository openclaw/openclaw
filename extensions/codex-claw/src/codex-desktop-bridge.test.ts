import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_CLAW_CONFIG_FILENAME,
  CODEX_CLAW_MARKETPLACE_DIRNAME,
  formatStatus,
  installCodexClawBridge,
  readCodexClawStatus,
} from "./codex-desktop-bridge.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-codex-claw-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Codex Claw Desktop bridge", () => {
  it("writes the Codex marketplace payload and path-based config", () => {
    const root = makeTempDir();
    const codexHome = path.join(root, ".codex");
    const workspaceDir = path.join(root, "workspace");
    const agentsPath = path.join(workspaceDir, "AGENTS.md");
    const soulPath = path.join(workspaceDir, "SOUL.md");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(agentsPath, "SECRET AGENTS CONTENT", { encoding: "utf8", flag: "wx" });
    writeFileSync(soulPath, "SECRET SOUL CONTENT", { encoding: "utf8", flag: "wx" });

    const result = installCodexClawBridge({
      codexHome,
      workspaceDir,
      agentsPath,
      soulPath,
      env: { HOME: root },
    });

    expect(result.warnings).toEqual([]);
    expect(result.marketplaceDir).toBe(path.join(codexHome, CODEX_CLAW_MARKETPLACE_DIRNAME));
    expect(
      readFileSync(path.join(result.marketplaceDir, ".agents/plugins/marketplace.json"), "utf8"),
    ).toContain("codex-claw");
    expect(
      readFileSync(path.join(result.marketplaceDir, "plugins/codex-claw/hooks.json"), "utf8"),
    ).toContain("UserPromptSubmit");

    const config = JSON.parse(
      readFileSync(path.join(codexHome, CODEX_CLAW_CONFIG_FILENAME), "utf8"),
    );
    expect(config).toMatchObject({
      agentsPath,
      soulPath,
      mode: "full",
      userPromptReinject: "after_compact",
    });

    const placeholderAgents = readFileSync(
      path.join(result.marketplaceDir, "plugins/codex-claw/assets/AGENTS.md"),
      "utf8",
    );
    expect(placeholderAgents).not.toContain("SECRET AGENTS CONTENT");

    const hookOutput = execFileSync(
      process.execPath,
      [
        path.join(result.marketplaceDir, "plugins/codex-claw/scripts/load-context.mjs"),
        "--hook-event",
        "SessionStart",
        "--mode",
        "full",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          CODEX_CLAW_CONFIG: result.configPath,
          CODEX_CLAW_LOG: path.join(root, "codex-claw-hook.log"),
        },
        input: "",
      },
    );
    const hookResponse = JSON.parse(hookOutput);
    expect(hookResponse.hookSpecificOutput.additionalContext).toContain("SECRET AGENTS CONTENT");
    expect(hookResponse.hookSpecificOutput.additionalContext).toContain("SECRET SOUL CONTENT");
    expect(hookResponse.hookSpecificOutput.additionalContext).toContain(
      "Native Codex system, developer, safety, tool, and direct user instructions take priority",
    );
  });

  it("reports missing source files without failing install", () => {
    const root = makeTempDir();
    const codexHome = path.join(root, ".codex");
    const result = installCodexClawBridge({
      codexHome,
      workspaceDir: path.join(root, "workspace"),
      env: { HOME: root },
    });

    expect(result.warnings).toEqual([
      `AGENTS.md path does not exist yet: ${path.join(root, "workspace", "AGENTS.md")}`,
      `SOUL.md path does not exist yet: ${path.join(root, "workspace", "SOUL.md")}`,
    ]);
    const status = readCodexClawStatus({ codexHome, env: { HOME: root } });
    expect(status.marketplaceInstalled).toBe(true);
    expect(status.agentsPathExists).toBe(false);
    expect(status.soulPathExists).toBe(false);
    expect(formatStatus(status)).toContain("missing");
  });

  it("surfaces invalid config JSON in status", () => {
    const root = makeTempDir();
    const codexHome = path.join(root, ".codex");
    installCodexClawBridge({ codexHome, env: { HOME: root } });
    writeFileSync(path.join(codexHome, CODEX_CLAW_CONFIG_FILENAME), "{ nope", "utf8");

    const status = readCodexClawStatus({ codexHome, env: { HOME: root } });

    expect(status.configExists).toBe(true);
    expect(status.configError).toBeTruthy();
    expect(formatStatus(status)).toContain("Config error:");
  });
});
