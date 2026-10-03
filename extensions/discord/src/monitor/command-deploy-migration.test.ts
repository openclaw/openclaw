import fs from "node:fs/promises";
import path from "node:path";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectDiscordCommandDeployCacheMigration } from "./command-deploy-migration.js";

let stateWorkspace: TempWorkspace;

beforeEach(async () => {
  stateWorkspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-discord-command-cache-migration-",
  });
});

afterEach(async () => {
  await stateWorkspace.cleanup();
});

function detectMigrations(stateDir: string) {
  return detectDiscordCommandDeployCacheMigration({
    cfg: {},
    env: {},
    oauthDir: path.join(stateDir, "credentials"),
    stateDir,
  });
}

describe("Discord command deployment cache migration", () => {
  it("plans legacy command deployment cache deletion without importing hashes", async () => {
    const stateDir = stateWorkspace.dir;
    const sourcePath = path.join(stateDir, "discord", "command-deploy-cache.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "{malformed cache", "utf8");

    const plans = await detectMigrations(stateDir);

    expect(plans).toHaveLength(1);
    const plan = plans?.[0];
    if (plan?.kind !== "plugin-state-import") {
      throw new Error("expected plugin-state import plan");
    }
    expect(plan).toMatchObject({
      label: "Discord command deployment cache",
      pluginId: "discord",
      namespace: "command-deploy-hashes",
      maxEntries: 10_000,
      cleanupSource: "remove",
      cleanupWhenEmpty: true,
    });
    expect(await plan.readEntries()).toEqual([]);
  });
});
