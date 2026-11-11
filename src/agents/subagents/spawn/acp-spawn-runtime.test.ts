import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { formatAcpSpawnCwdError, resolveRuntimeCwdForAcpSpawn } from "./acp-spawn-runtime.js";

it("leaves an external cwd to its owner while checking configured workspaces", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const cwd = state.path("external");
    const managed = state.path("managed");
    const managedChild = path.join(managed, "child");
    const restrictedChild = path.join(managed, "restricted-child");
    await fs.mkdir(cwd);
    await fs.mkdir(managedChild, { recursive: true });
    await fs.mkdir(restrictedChild);
    const source = path.join(cwd, "openclaw-workspace-state.json");
    await fs.writeFile(source, "not-json");
    await fs.writeFile(path.join(managed, "openclaw-workspace-state.json"), "not-json");

    await expect(
      resolveRuntimeCwdForAcpSpawn({
        cfg: {},
        resolvedCwd: cwd,
        explicitCwd: cwd,
        managedWorkspaceDir: managed,
        configuredWorkspaceDirs: [managed],
      }),
    ).resolves.toBe(cwd);
    await expect(
      resolveRuntimeCwdForAcpSpawn({
        cfg: {},
        resolvedCwd: managed,
        explicitCwd: managed,
        managedWorkspaceDir: managed,
        configuredWorkspaceDirs: [managed],
      }),
    ).rejects.toMatchObject({ kind: "legacy-workspace" });
    const failure = await resolveRuntimeCwdForAcpSpawn({
      cfg: {},
      resolvedCwd: managedChild,
      explicitCwd: managedChild,
      managedWorkspaceDir: managed,
      configuredWorkspaceDirs: [managed],
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "legacy-workspace" });
    expect(formatAcpSpawnCwdError(failure, false)).toContain("Gateway log");
    await expect(
      resolveRuntimeCwdForAcpSpawn({
        cfg: {},
        resolvedCwd: restrictedChild,
        managedWorkspaceDir: managed,
        configuredWorkspaceDirs: [managed],
        requireExistingCwd: true,
      }),
    ).rejects.toMatchObject({ kind: "legacy-workspace" });
    await fs.rm(path.join(managed, "openclaw-workspace-state.json"));
    await fs.writeFile(path.join(managedChild, "openclaw-workspace-state.json"), "not-json");
    await expect(
      resolveRuntimeCwdForAcpSpawn({
        cfg: {},
        resolvedCwd: managedChild,
        explicitCwd: managedChild,
        managedWorkspaceDir: managed,
        configuredWorkspaceDirs: [managed],
      }),
    ).rejects.toMatchObject({ kind: "legacy-workspace" });
    await expect(
      resolveRuntimeCwdForAcpSpawn({
        cfg: {},
        resolvedCwd: managedChild,
        explicitCwd: managedChild,
        managedWorkspaceDir: cwd,
        configuredWorkspaceDirs: [managedChild],
      }),
    ).rejects.toMatchObject({ kind: "legacy-workspace" });
    expect(await fs.readFile(source, "utf8")).toBe("not-json");
  });
});

it("refuses an explicit cwd in an owned sandbox copy awaiting repair", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const root = state.path("sandboxes");
    const copy = path.join(root, "agent-copy");
    await fs.mkdir(copy, { recursive: true });
    await fs.writeFile(path.join(copy, "openclaw-workspace-state.json"), "retained");
    await expect(
      resolveRuntimeCwdForAcpSpawn({
        cfg: {
          agents: {
            defaults: { sandbox: { mode: "all", scope: "agent", workspaceRoot: root } },
          },
        },
        resolvedCwd: copy,
        explicitCwd: copy,
        managedWorkspaceDir: state.path("agent-workspace"),
        configuredWorkspaceDirs: [state.path("agent-workspace")],
      }),
    ).rejects.toMatchObject({ kind: "legacy-workspace" });
  });
});

it("refuses an inherited missing cwd with a retained sibling marker", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const managed = state.path("managed");
    const missing = path.join(managed, "missing");
    await fs.mkdir(managed);
    await fs.writeFile(`${missing}.attested`, "openclaw-workspace-attestation:v1\n");
    await expect(
      resolveRuntimeCwdForAcpSpawn({
        cfg: {},
        resolvedCwd: missing,
        managedWorkspaceDir: managed,
        configuredWorkspaceDirs: [managed],
      }),
    ).rejects.toMatchObject({ kind: "legacy-workspace" });
    await fs.rm(`${missing}.attested`);
    await expect(
      resolveRuntimeCwdForAcpSpawn({
        cfg: {},
        resolvedCwd: missing,
        managedWorkspaceDir: managed,
        configuredWorkspaceDirs: [managed],
      }),
    ).resolves.toBeUndefined();
  });
});
