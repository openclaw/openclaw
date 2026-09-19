import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolvePodmanSandboxCreatePolicy } from "./podman-runtime.js";
import { createSandboxTestContext } from "./test-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function params() {
  const sandbox = createSandboxTestContext();
  return {
    cfg: { ...sandbox.docker, binds: [], tmpfs: [] },
    dockerTmpfsSource: "configured" as const,
    workspaceDir: sandbox.workspaceDir,
    agentWorkspaceDir: sandbox.workspaceDir,
    workspaceAccess: "rw" as const,
    readOnlyWorkspaceSkillMounts: [],
    runtimeInfo: {
      machine: false,
      rootless: false,
      version: "5.0.0",
      target: { key: "local", globalArgs: [] },
    },
  };
}

describe("Podman mount path identity", () => {
  it.each(["bind", "tmpfs"] as const)(
    "keeps /run-space distinct from the init path in %s targets",
    (kind) => {
      for (const target of ["/run", "/run/podman-init", "/run "]) {
        const input = params();
        const cfg = {
          ...input.cfg,
          binds: kind === "bind" ? [`/project:${target}`] : [],
          tmpfs: kind === "tmpfs" ? [target] : [],
        };
        const create = () => resolvePodmanSandboxCreatePolicy({ ...input, cfg });
        if (target === "/run ") {
          expect(create).not.toThrow();
        } else {
          expect(create).toThrow("would cover Podman's init path");
        }
      }
    },
  );

  it("removes only the exact default /run tmpfs", () => {
    const input = params();
    expect(
      resolvePodmanSandboxCreatePolicy({
        ...input,
        dockerTmpfsSource: "default",
        cfg: { ...input.cfg, tmpfs: ["/run", "/run "] },
      }).cfg.tmpfs,
    ).toEqual(["/run "]);
  });

  it.runIf(process.platform !== "win32")(
    "checks the actual spaced source against the Machine home share",
    () => {
      const root = tempDirs.make("openclaw-podman-spaces-");
      const home = path.join(root, "home");
      const workspaceDir = path.join(home, "workspace");
      const outside = path.join(root, "outside");
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.mkdirSync(path.join(home, "data"));
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(home, "data "));
      vi.spyOn(os, "homedir").mockReturnValue(home);
      const input = params();
      expect(() =>
        resolvePodmanSandboxCreatePolicy({
          ...input,
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          cfg: {
            ...input.cfg,
            binds: [`${home}/data :/data`],
            dangerouslyAllowExternalBindSources: true,
          },
          runtimeInfo: { ...input.runtimeInfo, machine: true },
        }),
      ).toThrow("outside the default host home share");
    },
  );
});
