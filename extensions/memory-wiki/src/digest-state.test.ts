import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetPluginBlobStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  importMemoryWikiLegacyDigestFiles,
  legacyMemoryWikiDigestFilesExist,
  readMemoryWikiAgentDigestSync,
  readMemoryWikiCompiledDigestBundle,
  resolveMemoryWikiLegacyDigestPath,
  writeMemoryWikiCompiledDigests,
} from "./digest-state.js";

describe("memory wiki compiled digest state", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const roots: string[] = [];

  afterEach(async () => {
    resetPluginBlobStoreForTests();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function createVaultRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-digest-"));
    roots.push(root);
    process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
    return root;
  }

  it("stores compiled digests in SQLite plugin blob state", async () => {
    const vaultRoot = await createVaultRoot();

    await writeMemoryWikiCompiledDigests({
      vaultRoot,
      agentDigest: '{"claimCount":1,"pages":[]}\n',
      claimsDigest: '{"text":"Alpha"}\n',
    });

    expect(readMemoryWikiAgentDigestSync(vaultRoot)).toBe('{"claimCount":1,"pages":[]}\n');
    await expect(readMemoryWikiCompiledDigestBundle(vaultRoot)).resolves.toEqual({
      agentDigest: '{"claimCount":1,"pages":[]}\n',
      claimsDigest: '{"text":"Alpha"}\n',
    });
    await expect(
      fs.stat(resolveMemoryWikiLegacyDigestPath(vaultRoot, "agent-digest")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("imports legacy cache files through the migration helper", async () => {
    const vaultRoot = await createVaultRoot();
    const agentPath = resolveMemoryWikiLegacyDigestPath(vaultRoot, "agent-digest");
    const claimsPath = resolveMemoryWikiLegacyDigestPath(vaultRoot, "claims-digest");
    await fs.mkdir(path.dirname(agentPath), { recursive: true });
    await fs.writeFile(agentPath, '{"claimCount":2,"pages":[]}\n', "utf8");
    await fs.writeFile(claimsPath, '{"text":"Beta"}\n', "utf8");

    await expect(legacyMemoryWikiDigestFilesExist(vaultRoot)).resolves.toBe(true);
    await expect(importMemoryWikiLegacyDigestFiles({ vaultRoot })).resolves.toMatchObject({
      imported: 2,
      warnings: [],
    });

    await expect(readMemoryWikiCompiledDigestBundle(vaultRoot)).resolves.toEqual({
      agentDigest: '{"claimCount":2,"pages":[]}\n',
      claimsDigest: '{"text":"Beta"}\n',
    });
    await expect(fs.stat(agentPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(claimsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
