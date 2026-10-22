import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import plugin from "../index.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
afterEach(() => {
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
});
const registerMemoryCapability = vi.fn<OpenClawPluginApi["registerMemoryCapability"]>();
plugin.register(createTestPluginApi({ registerMemoryCapability }));
const artifacts = registerMemoryCapability.mock.calls[0]?.[0].publicArtifacts;

it("lists the canonical memory root through the plugin, not the lowercase legacy root", async () => {
  const workspaceDir = tempDirs.make("memory-core-public-artifacts-");
  vi.stubEnv("OPENCLAW_STATE_DIR", workspaceDir);
  const cfg = { agents: { entries: { main: { workspace: workspaceDir } } } };
  await fs.writeFile(path.join(workspaceDir, "memory.md"), "# Legacy memory\n");
  await expect(artifacts?.listArtifacts({ cfg })).resolves.toEqual([]);
  await fs.rename(path.join(workspaceDir, "memory.md"), path.join(workspaceDir, "MEMORY.md"));
  expect((await artifacts?.listArtifacts({ cfg }))?.map((entry) => entry.relativePath)).toEqual([
    "MEMORY.md",
  ]);
});
