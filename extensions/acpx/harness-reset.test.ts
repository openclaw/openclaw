import fs from "node:fs/promises";
import path from "node:path";
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "./index.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("resets every registered ACP harness with a read-only package directory", async () => {
  const root = directories.make("acpx-harness-reset-");
  const packageDir = path.join(root, "release");
  const stateDir = path.join(root, "state");
  await fs.mkdir(packageDir, { mode: 0o555 });
  await fs.mkdir(stateDir);
  vi.spyOn(process, "cwd").mockReturnValue(packageDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const harnesses: AgentHarnessV2[] = [];
  plugin.register(
    createTestPluginApi({
      runtime: createPluginRuntimeMock({
        config: { current: () => ({}) },
        state: {
          resolveStateDir,
          // Host-owned identity/lease storage is outside this filesystem contract.
          openKeyedStore: () => ({
            lookup: async () => undefined,
            register: async () => {},
            registerIfAbsent: async () => true,
            entries: async () => [],
            consume: async () => undefined,
            delete: async () => false,
            clear: async () => {},
          }),
        },
      }),
      registerAgentHarness: (harness) => harnesses.push(harness),
    }),
  );
  try {
    expect(harnesses.map((harness) => harness.id)).toEqual([
      "acp-opencode",
      "acp-qwen",
      "acp-pi",
      "acp-kilocode",
      "acp-copilot",
    ]);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await expect(fs.access(packageDir, fs.constants.W_OK)).rejects.toMatchObject({
        code: "EACCES",
      });
    }
    const results = await Promise.allSettled(
      harnesses.map(
        async (harness) =>
          await harness.reset!({
            reason: "reset",
            agentId: "main",
            sessionId: "session-to-reset",
            sessionKey: "agent:main:main",
          }),
      ),
    );
    expect(results).toEqual(harnesses.map(() => ({ status: "fulfilled", value: undefined })));
    await expect(fs.readdir(path.join(stateDir, "acpx", "sessions"))).resolves.toEqual([]);
    await expect(fs.readdir(packageDir)).resolves.toEqual([]);
  } finally {
    await Promise.all(harnesses.map(async (harness) => await harness.dispose?.()));
    await fs.chmod(packageDir, 0o755);
  }
});
