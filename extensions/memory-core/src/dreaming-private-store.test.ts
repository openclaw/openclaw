import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import {
  readDreamingPrivateJsonIfExists,
  writeDreamingPrivateJson,
} from "./dreaming-private-store.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
});

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

  it("keeps writes inside the workspace when memory is swapped to a symlink during setup", async () => {
    if (process.platform === "win32") {
      return;
    }
    const workspaceDir = await createTempWorkspace("dreaming-private-store-swap-");
    const memoryDir = path.join(workspaceDir, "memory");
    const externalDir = await createTempWorkspace("dreaming-private-store-external-");
    await fs.mkdir(memoryDir, { recursive: true });
    await chmodIfSupported(workspaceDir, 0o770);
    await chmodIfSupported(memoryDir, 0o770);

    let swapped = false;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation: async (operation, targetPath) => {
        if (
          operation !== "mkdir" ||
          swapped ||
          path.normalize(targetPath) !== path.join(memoryDir, ".dreams")
        ) {
          return;
        }
        swapped = true;
        await fs.rm(memoryDir, { recursive: true, force: true });
        await fs.symlink(externalDir, memoryDir);
      },
    });

    await expect(
      writeDreamingPrivateJson(workspaceDir, path.join("memory", ".dreams", "state.json"), {
        ok: true,
      }),
    ).rejects.toThrow();
    await expect(fs.access(path.join(externalDir, ".dreams", "state.json"))).rejects.toThrow();
  });

  it("does not chmod outside the workspace when .dreams is swapped to a symlink before chmod", async () => {
    if (process.platform === "win32") {
      return;
    }
    const workspaceDir = await createTempWorkspace("dreaming-private-store-chmod-swap-");
    const memoryDir = path.join(workspaceDir, "memory");
    const dreamsDir = path.join(memoryDir, ".dreams");
    const externalDir = await createTempWorkspace("dreaming-private-store-chmod-external-");
    await fs.mkdir(dreamsDir, { recursive: true });
    await chmodIfSupported(workspaceDir, 0o770);
    await chmodIfSupported(memoryDir, 0o770);
    await chmodIfSupported(dreamsDir, 0o770);
    await chmodIfSupported(externalDir, 0o770);

    const realOpen = fs.open.bind(fs);
    let swapped = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const [target, flags] = args;
      if (!swapped && path.normalize(String(target)) === dreamsDir) {
        swapped = true;
        await fs.rm(dreamsDir, { recursive: true, force: true });
        await fs.symlink(externalDir, dreamsDir);
      }
      return await realOpen(...args);
    });

    try {
      await expect(
        writeDreamingPrivateJson(workspaceDir, path.join("memory", ".dreams", "state.json"), {
          ok: true,
        }),
      ).rejects.toThrow();
      const openCall = openSpy.mock.calls.find(
        ([target]) => path.normalize(String(target)) === dreamsDir,
      );
      expect(openCall).toBeDefined();
      expect(typeof openCall?.[1]).toBe("number");
      expect((Number(openCall?.[1]) & fsConstants.O_NOFOLLOW) === fsConstants.O_NOFOLLOW).toBe(
        true,
      );
      expect(await posixMode(externalDir)).toBe(0o770);
      await expect(fs.access(path.join(externalDir, "state.json"))).rejects.toThrow();
    } finally {
      openSpy.mockRestore();
    }
  });
});
