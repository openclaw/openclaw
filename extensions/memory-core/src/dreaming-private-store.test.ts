import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readDreamingPrivateJsonIfExists,
  writeDreamingPrivateJson,
} from "./dreaming-private-store.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

async function chmodIfSupported(target: string, mode: number): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  await fs.chmod(target, mode);
}

async function posixMode(target: string): Promise<number | null> {
  if (process.platform === "win32") {
    return null;
  }
  return (await fs.stat(target)).mode & 0o777;
}

describe("dreaming private store", () => {
  it("does not harden the workspace root or memory directory when writing private artifacts", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-private-store-");
    const memoryDir = path.join(workspaceDir, "memory");
    const dreamsDir = path.join(memoryDir, ".dreams");
    await fs.mkdir(dreamsDir, { recursive: true });
    await chmodIfSupported(workspaceDir, 0o770);
    await chmodIfSupported(memoryDir, 0o770);
    await chmodIfSupported(dreamsDir, 0o770);

    await writeDreamingPrivateJson(workspaceDir, path.join("memory", ".dreams", "state.json"), {
      ok: true,
    });

    expect(
      await readDreamingPrivateJsonIfExists(
        workspaceDir,
        path.join("memory", ".dreams", "state.json"),
      ),
    ).toEqual({
      ok: true,
    });
    expect(await posixMode(workspaceDir)).toBe(process.platform === "win32" ? null : 0o770);
    expect(await posixMode(memoryDir)).toBe(process.platform === "win32" ? null : 0o770);
    expect(await posixMode(dreamsDir)).toBe(process.platform === "win32" ? null : 0o700);
    expect(await posixMode(path.join(dreamsDir, "state.json"))).toBe(
      process.platform === "win32" ? null : 0o600,
    );
  });

  it("rejects private artifact paths outside memory/.dreams", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-private-store-reject-");

    await expect(
      writeDreamingPrivateJson(workspaceDir, path.join("memory", "state.json"), {}),
    ).rejects.toThrow("memory/.dreams");
  });

  it("rejects a symlinked memory directory before using the private store root", async () => {
    if (process.platform === "win32") {
      return;
    }
    const workspaceDir = await createTempWorkspace("dreaming-private-store-symlink-memory-");
    const externalMemoryDir = await createTempWorkspace("dreaming-private-store-external-");
    await fs.symlink(externalMemoryDir, path.join(workspaceDir, "memory"));

    await expect(
      writeDreamingPrivateJson(workspaceDir, path.join("memory", ".dreams", "state.json"), {
        ok: true,
      }),
    ).rejects.toThrow("symlinked dreaming private store path");
  });

  it("rejects a symlinked .dreams directory before writing private artifacts", async () => {
    if (process.platform === "win32") {
      return;
    }
    const workspaceDir = await createTempWorkspace("dreaming-private-store-symlink-dreams-");
    const memoryDir = path.join(workspaceDir, "memory");
    const externalDreamsDir = await createTempWorkspace("dreaming-private-store-external-dreams-");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.symlink(externalDreamsDir, path.join(memoryDir, ".dreams"));

    await expect(
      writeDreamingPrivateJson(workspaceDir, path.join("memory", ".dreams", "state.json"), {
        ok: true,
      }),
    ).rejects.toThrow("symlinked dreaming private store path");
  });
});
