import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDiscordSlashCommandDeployStoreKey,
  clearDiscordSlashCommandDeployHashes,
  mergeDiscordSlashCommandDeployHashes,
  readDiscordSlashCommandDeployHashes,
} from "./slash-command-deploy-state.js";

const tempDirs: string[] = [];

async function createStateEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-disc-slash-deploy-"));
  tempDirs.push(dir);
  return { ...process.env, OPENCLAW_STATE_DIR: dir };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("slash command deploy persistence", () => {
  it("merges fingerprints and restores them via read", async () => {
    const env = await createStateEnv();
    await mergeDiscordSlashCommandDeployHashes({
      env,
      applicationId: "9".repeat(12),
      accountId: "default",
      hashes: { "global:reconcile": "a".repeat(64) },
    });

    const readBack = await readDiscordSlashCommandDeployHashes({
      env,
      applicationId: "9".repeat(12),
      accountId: "default",
    });
    expect(readBack["global:reconcile"]).toBe("a".repeat(64));
  });

  it("stores entries namespaced per application and account keys", async () => {
    const env = await createStateEnv();
    await mergeDiscordSlashCommandDeployHashes({
      env,
      applicationId: "9".repeat(12),
      accountId: "primary",
      hashes: { "global:reconcile": "b".repeat(64) },
    });
    await mergeDiscordSlashCommandDeployHashes({
      env,
      applicationId: "8".repeat(12),
      accountId: "primary",
      hashes: { "global:reconcile": "c".repeat(64) },
    });

    const first = await readDiscordSlashCommandDeployHashes({
      env,
      applicationId: "9".repeat(12),
      accountId: "primary",
    });
    expect(first["global:reconcile"]).toBe("b".repeat(64));

    const second = await readDiscordSlashCommandDeployHashes({
      env,
      applicationId: "8".repeat(12),
      accountId: "primary",
    });
    expect(second["global:reconcile"]).toBe("c".repeat(64));
  });

  it("drops persisted hashes when clearing an account/application entry", async () => {
    const env = await createStateEnv();
    await mergeDiscordSlashCommandDeployHashes({
      env,
      applicationId: "9".repeat(12),
      accountId: "default",
      hashes: { "global:reconcile": "d".repeat(64) },
    });
    await clearDiscordSlashCommandDeployHashes({
      env,
      applicationId: "9".repeat(12),
      accountId: "default",
    });

    expect(
      Object.keys(
        await readDiscordSlashCommandDeployHashes({
          env,
          applicationId: "9".repeat(12),
          accountId: "default",
        }),
      ).length,
    ).toBe(0);
  });

  it("buildDiscordSlashCommandDeployStoreKey matches persisted entries", async () => {
    const env = await createStateEnv();
    const applicationId = "9".repeat(12);
    const accountId = "workspace";
    const key = buildDiscordSlashCommandDeployStoreKey({ applicationId, accountId });
    await mergeDiscordSlashCommandDeployHashes({
      env,
      applicationId,
      accountId,
      hashes: { "guild:111": "e".repeat(64) },
    });
    const filePath = path.join(
      env.OPENCLAW_STATE_DIR as string,
      "discord",
      "slash-command-deploy-hashes.json",
    );
    const raw = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(Object.keys(raw.entries)).toContain(key);
  });
});
