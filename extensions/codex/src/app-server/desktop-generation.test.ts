import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readMacOSDesktopGenerationFingerprint } from "./desktop-generation-fingerprint.js";
import { createCodexDesktopGenerationOwner } from "./desktop-generation-owner.js";

function createOwner(
  options: Omit<Parameters<typeof createCodexDesktopGenerationOwner>[0], "signal">,
) {
  return createCodexDesktopGenerationOwner({ signal: new AbortController().signal, ...options });
}

async function settle<T>(pending: Promise<T>) {
  await vi.advanceTimersByTimeAsync(1_000);
  return pending;
}

describe("Codex desktop generation owner", () => {
  afterEach(() => vi.useRealTimers());

  it("retries fingerprint discovery after a failed read", async () => {
    vi.useFakeTimers();
    const error = new Error("desktop bundle is being replaced");
    const readFingerprint = vi.fn().mockRejectedValueOnce(error).mockResolvedValue("desktop-y");
    const owner = createOwner({ readFingerprint });
    const first = owner.refresh().catch((cause: unknown) => cause);
    await expect(settle(first)).resolves.toBe(error);
    await expect(settle(owner.wait())).resolves.toEqual({ epoch: 1, fingerprint: "desktop-y" });
    expect(readFingerprint).toHaveBeenCalledTimes(2);
  });

  it("coalesces waiters and keeps the generation for an unchanged snapshot", async () => {
    vi.useFakeTimers();
    const readFingerprint = vi.fn(async () => "X");
    const changed = vi.fn();
    const owner = createOwner({ readFingerprint, onGenerationChange: changed });
    await settle(owner.refresh());
    readFingerprint.mockClear();

    owner.markDirty();
    const [left, right] = await settle(Promise.all([owner.wait(), owner.wait()]));

    expect(left).toBe(right);
    expect(left).toEqual({ epoch: 1, fingerprint: "X" });
    expect(readFingerprint).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
  });

  it("settles a replaced desktop bundle as a new generation", async () => {
    await withTempDir("openclaw-codex-generation-replacement-", async (root) => {
      const appBundlePath = path.join(root, "ChatGPT.app");
      const resources = path.join(appBundlePath, "Contents/Resources");
      const chatGpt = {
        appName: "ChatGPT.app" as const,
        appBundlePath,
        appServerCommandPath: path.join(resources, "codex-cli/CodexCLI.app/Contents/MacOS/codex"),
        bundledMarketplacePath: path.join(resources, "plugins/openai-bundled"),
        computerUseServiceAppPaths: [],
      };
      await writeCommand(chatGpt.appServerCommandPath, "chatgpt-x");
      const initialFingerprint = await readMacOSDesktopGenerationFingerprint([chatGpt]);

      await fs.rename(chatGpt.appBundlePath, `${chatGpt.appBundlePath}.previous`);
      await writeCommand(chatGpt.appServerCommandPath, "chatgpt-y");
      const updatedFingerprint = await readMacOSDesktopGenerationFingerprint([chatGpt]);
      expect(updatedFingerprint).not.toBe(initialFingerprint);

      vi.useFakeTimers();
      let fingerprint = initialFingerprint;
      const owner = createOwner({ readFingerprint: async () => fingerprint });
      await expect(settle(owner.refresh())).resolves.toMatchObject({ epoch: 1 });

      fingerprint = updatedFingerprint;
      owner.markDirty();
      await expect(settle(owner.wait())).resolves.toMatchObject({ epoch: 2 });
    });
  });
});

async function writeCommand(commandPath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, contents);
}
