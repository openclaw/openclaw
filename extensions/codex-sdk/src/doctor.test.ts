import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexSdkPluginConfig } from "./config.js";
import { createCodexCompatibilityRecord } from "./doctor.js";
import { FileCodexNativeStateStore } from "./state.js";

const tempDirs: string[] = [];

async function createStore(): Promise<FileCodexNativeStateStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-sdk-doctor-test-"));
  tempDirs.push(dir);
  return new FileCodexNativeStateStore({ stateDir: dir });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("createCodexCompatibilityRecord", () => {
  it("records passing compatibility checks", async () => {
    const probeRuntime = vi.fn(async () => {});
    const record = await createCodexCompatibilityRecord({
      config: resolveCodexSdkPluginConfig({ workspaceDir: "/tmp/workspace" }),
      stateStore: await createStore(),
      probeRuntime,
      loadSdk: async () => ({ Codex: class {} }),
    });

    expect(record.ok).toBe(true);
    expect(record.backend).toBe("codex-sdk");
    expect(record.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "sdk_import",
        "route_registry",
        "mcp_backchannel",
        "state_writable",
        "runtime_probe",
      ]),
    );
    expect(probeRuntime).toHaveBeenCalledOnce();
  });

  it("marks failed SDK imports and runtime probes", async () => {
    const record = await createCodexCompatibilityRecord({
      config: resolveCodexSdkPluginConfig({ workspaceDir: "/tmp/workspace" }),
      stateStore: await createStore(),
      probeRuntime: async () => {
        throw new Error("probe failed");
      },
      loadSdk: async () => {
        throw new Error("missing sdk");
      },
    });

    expect(record.ok).toBe(false);
    expect(record.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "sdk_import", status: "fail" }),
        expect.objectContaining({ id: "runtime_probe", status: "fail" }),
      ]),
    );
  });
});
