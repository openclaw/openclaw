import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { resolveRuntimeCwdForAcpSpawn } from "./acp-spawn-runtime.js";

it("leaves an explicit external cwd to its owner", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const cwd = state.path("external");
    const managed = state.path("managed");
    const managedChild = path.join(managed, "child");
    await fs.mkdir(cwd);
    await fs.mkdir(managedChild, { recursive: true });
    const source = path.join(cwd, "openclaw-workspace-state.json");
    await fs.writeFile(source, "not-json");
    await fs.writeFile(path.join(managed, "openclaw-workspace-state.json"), "not-json");

    await expect(
      resolveRuntimeCwdForAcpSpawn({
        resolvedCwd: cwd,
        explicitCwd: cwd,
        managedWorkspaceDir: managed,
      }),
    ).resolves.toBe(cwd);
    await expect(
      resolveRuntimeCwdForAcpSpawn({
        resolvedCwd: managed,
        explicitCwd: managed,
        managedWorkspaceDir: managed,
      }),
    ).rejects.toMatchObject({ kind: "legacy-workspace" });
    await expect(
      resolveRuntimeCwdForAcpSpawn({
        resolvedCwd: managedChild,
        explicitCwd: managedChild,
        managedWorkspaceDir: managed,
      }),
    ).rejects.toMatchObject({ kind: "legacy-workspace" });
    expect(await fs.readFile(source, "utf8")).toBe("not-json");
  });
});
