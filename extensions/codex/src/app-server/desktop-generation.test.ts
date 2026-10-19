import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readMacOSDesktopGenerationFingerprint } from "./desktop-generation-fingerprint.js";
import { createCodexDesktopGenerationOwner } from "./desktop-generation-owner.js";

describe("Codex desktop generation owner", () => {
  afterEach(() => vi.useRealTimers());

  it("retries fingerprint discovery after a failed read", async () => {
    vi.useFakeTimers();
    const error = new Error("desktop bundle is being replaced");
    const readFingerprint = vi.fn().mockRejectedValueOnce(error).mockResolvedValue("desktop-y");
    const owner = createCodexDesktopGenerationOwner({
      signal: new AbortController().signal,
      readFingerprint,
    });
    const first = owner.refresh().catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBe(error);

    const recovered = owner.wait();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(recovered).resolves.toEqual({ epoch: 1, fingerprint: "desktop-y" });
    expect(readFingerprint).toHaveBeenCalledTimes(2);
  });

  it("coalesces waiters and keeps the generation for an unchanged snapshot", async () => {
    vi.useFakeTimers();
    const fingerprint = "X";
    const readFingerprint = vi.fn(async () => fingerprint);
    const changed = vi.fn();
    const owner = createCodexDesktopGenerationOwner({
      signal: new AbortController().signal,
      readFingerprint,
      onGenerationChange: changed,
    });
    const initial = owner.refresh();
    await vi.advanceTimersByTimeAsync(1_000);
    await initial;
    readFingerprint.mockClear();

    owner.markDirty();
    const pending = Promise.all([owner.wait(), owner.wait()]);
    await vi.advanceTimersByTimeAsync(1_000);
    const [left, right] = await pending;

    expect(left).toBe(right);
    expect(left).toEqual({ epoch: 1, fingerprint: "X" });
    expect(readFingerprint).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
  });

  it("settles a replaced desktop bundle as a new generation", async () => {
    await withTempDir("openclaw-codex-generation-replacement-", async (root) => {
      const chatGpt = candidate(root, "ChatGPT.app");
      await writeCommand(chatGpt.appServerCommandPath, "chatgpt-x");
      const initialFingerprint = await readMacOSDesktopGenerationFingerprint([chatGpt]);

      await fs.rename(chatGpt.appBundlePath, `${chatGpt.appBundlePath}.previous`);
      await writeCommand(chatGpt.appServerCommandPath, "chatgpt-y");
      const updatedFingerprint = await readMacOSDesktopGenerationFingerprint([chatGpt]);
      expect(updatedFingerprint).not.toBe(initialFingerprint);

      vi.useFakeTimers();
      let fingerprint = initialFingerprint;
      const owner = createCodexDesktopGenerationOwner({
        signal: new AbortController().signal,
        readFingerprint: async () => fingerprint,
      });
      const initial = owner.refresh();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(initial).resolves.toMatchObject({ epoch: 1 });

      fingerprint = updatedFingerprint;
      owner.markDirty();
      const updated = owner.wait();
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(updated).resolves.toMatchObject({ epoch: 2 });
    });
  });
});

function candidate(root: string, appName: "ChatGPT.app" | "Codex.app") {
  const appBundlePath = path.join(root, appName);
  return {
    appName,
    appBundlePath,
    appServerCommandPath: path.join(
      appBundlePath,
      "Contents",
      "Resources",
      "codex-cli",
      "CodexCLI.app",
      "Contents",
      "MacOS",
      "codex",
    ),
    bundledMarketplacePath: path.join(
      appBundlePath,
      "Contents",
      "Resources",
      "plugins",
      "openai-bundled",
    ),
    computerUseServiceAppPaths: [],
  };
}

async function writeCommand(commandPath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, contents);
}
