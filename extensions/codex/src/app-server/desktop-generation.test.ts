import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readMacOSDesktopGenerationFingerprint,
  resolveMacOSDesktopGenerationWatchPaths,
} from "./desktop-generation-fingerprint.js";
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

  it.each([
    "plugins/openai-bundled/plugins/unified-computer-use",
    "cua_node/lib/node_modules/@oai/cua-repl",
  ])("settles same-version %s content changes as a new generation", async (artifactRelative) => {
    await withTempDir("openclaw-codex-generation-plugin-fingerprint-", async (root) => {
      const chatGpt = candidate(root, "ChatGPT.app");
      const pluginRoot = path.join(
        chatGpt.appBundlePath,
        "Contents",
        "Resources",
        artifactRelative,
      );
      const pluginName = path.basename(pluginRoot);
      await Promise.all([
        writeCommand(chatGpt.appServerCommandPath, "chatgpt-x"),
        fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true }),
      ]);
      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: pluginName, version: "1.0.0" }),
      );
      await fs.writeFile(path.join(pluginRoot, ".mcp.json"), "plugin-content-x");
      const initialFingerprint = await readMacOSDesktopGenerationFingerprint([chatGpt]);

      await fs.writeFile(path.join(pluginRoot, ".mcp.json"), "plugin-content-y");
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

  it("watches stable application roots for recursive artifact updates", () => {
    const fixture = candidate("/Applications", "ChatGPT.app");
    expect(resolveMacOSDesktopGenerationWatchPaths([fixture])).toEqual([
      "/Applications",
      fixture.appBundlePath,
    ]);
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
