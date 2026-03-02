import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSeatbeltFsBridge } from "./seatbelt-fs-bridge.js";
import { createSandboxTestContext } from "./test-fixtures.js";
import type { SandboxContext } from "./types.js";

function createSeatbeltSandbox(params: {
  workspaceDir: string;
  agentWorkspaceDir?: string;
  workspaceAccess?: SandboxContext["workspaceAccess"];
  dockerBinds?: string[];
}): SandboxContext {
  const profileDir = path.join(params.workspaceDir, "profiles");
  return createSandboxTestContext({
    overrides: {
      backend: "seatbelt",
      workspaceDir: params.workspaceDir,
      agentWorkspaceDir: params.agentWorkspaceDir ?? params.workspaceDir,
      workspaceAccess: params.workspaceAccess ?? "rw",
      containerName: "",
      containerWorkdir: params.workspaceDir,
      docker: {
        binds: params.dockerBinds,
      },
      seatbelt: {
        profileDir,
        profile: "demo-open",
        profilePath: path.join(profileDir, "demo-open.sb"),
        params: {},
      },
    },
  });
}

describe("seatbelt fs bridge", () => {
  it("reads and writes files via native fs operations", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-seatbelt-fs-"));
    const workspaceDir = path.join(stateDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    try {
      const bridge = createSeatbeltFsBridge({
        sandbox: createSeatbeltSandbox({ workspaceDir, workspaceAccess: "rw" }),
      });

      await bridge.writeFile({ filePath: "notes/todo.txt", data: "ship it" });

      const resolved = bridge.resolvePath({ filePath: "notes/todo.txt" });
      expect(resolved.hostPath).toBe(path.join(workspaceDir, "notes", "todo.txt"));
      expect(await fs.readFile(resolved.hostPath, "utf8")).toBe("ship it");

      const content = await bridge.readFile({ filePath: "notes/todo.txt" });
      expect(content.toString("utf8")).toBe("ship it");

      const stat = await bridge.stat({ filePath: "notes/todo.txt" });
      expect(stat?.type).toBe("file");
      expect(stat?.size).toBe("ship it".length);

      await bridge.remove({ filePath: "notes/todo.txt" });
      expect(await bridge.stat({ filePath: "notes/todo.txt" })).toBeNull();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("ignores docker.binds mounts when resolving seatbelt fs paths", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-seatbelt-fs-binds-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const externalDir = path.join(stateDir, "external");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(path.join(externalDir, "secret.txt"), "top-secret", "utf8");

    try {
      const bridge = createSeatbeltFsBridge({
        sandbox: createSeatbeltSandbox({
          workspaceDir,
          workspaceAccess: "rw",
          dockerBinds: [externalDir + ":/external:rw"],
        }),
      });

      await expect(bridge.readFile({ filePath: "/external/secret.txt" })).rejects.toThrow(
        /escapes allowed mounts|escapes sandbox root/,
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("enforces read-only workspace access at the tool layer", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-seatbelt-fs-ro-"));
    const workspaceDir = path.join(stateDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "README.md"), "hello");

    try {
      const bridge = createSeatbeltFsBridge({
        sandbox: createSeatbeltSandbox({ workspaceDir, workspaceAccess: "ro" }),
      });

      const content = await bridge.readFile({ filePath: "README.md" });
      expect(content.toString("utf8")).toBe("hello");

      await expect(bridge.writeFile({ filePath: "new.txt", data: "denied" })).rejects.toThrow(
        /read-only/,
      );
      await expect(bridge.mkdirp({ filePath: "nested" })).rejects.toThrow(/read-only/);
      await expect(bridge.remove({ filePath: "README.md" })).rejects.toThrow(/read-only/);
      await expect(bridge.rename({ from: "README.md", to: "README2.md" })).rejects.toThrow(
        /read-only/,
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
