import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cliMocks,
  sandboxMocks,
  installOpenShellBackendMocks,
  uninstallOpenShellBackendMocks,
  resetOpenShellBackendMocks,
  finalizeMirror,
  createOpenShellBackendFixture,
} from "./openshell-backend.test-support.js";
import { createOpenShellTestWorkspace, expectPathMissing } from "./openshell-fs.test-support.js";

describe("openshell filesystem inspection failures", () => {
  beforeAll(installOpenShellBackendMocks);
  afterAll(uninstallOpenShellBackendMocks);
  beforeEach(resetOpenShellBackendMocks);

  it.each(
    ["EIO", "EACCES"].flatMap((code) =>
      ["mirror write", "mirror stat", "shadow parent", "shadow directory", "remote skills"].map(
        (operation) => ({
          code,
          operation,
        }),
      ),
    ),
  )(
    "preserves existing data when $operation stat fails with $code",
    async ({ code, operation }) => {
      await using workspace = await createOpenShellTestWorkspace("stat-workspace");
      await using remote = await createOpenShellTestWorkspace("stat-remote");
      await using agentRemote = await createOpenShellTestWorkspace("stat-agent");
      await using skills = await createOpenShellTestWorkspace("stat-skills");
      sandboxMocks.remoteRoot = remote.dir;
      sandboxMocks.remoteAgentRoot = agentRemote.dir;
      const hostFile = path.join(workspace.dir, "note.txt");
      const remoteFile = path.join(remote.dir, "note.txt");
      const shadowDirectory = path.join(workspace.dir, ".openclaw", "sandbox-skills");
      const shadowFile = path.join(shadowDirectory, "host-only.txt");
      const remoteSkillFile = path.join(remote.dir, ".openclaw", "sandbox-skills", "last-good.txt");
      await fs.writeFile(hostFile, "old host bytes", "utf8");
      await fs.writeFile(remoteFile, "existing remote bytes", "utf8");
      await fs.mkdir(shadowDirectory, { recursive: true });
      await fs.writeFile(shadowFile, "host-only shadow", "utf8");
      await fs.mkdir(path.dirname(remoteSkillFile), { recursive: true });
      await fs.writeFile(remoteSkillFile, "last good skill view", "utf8");
      await fs.writeFile(path.join(skills.dir, "SKILL.md"), "# Synthetic skill\n", "utf8");
      cliMocks.runOpenShellCli.mockImplementation(async ({ args }: { args: string[] }) => {
        if (args[0] === "sandbox" && args[1] === "download") {
          const destination = expectDefined(args[4], "OpenShell download destination");
          await fs.writeFile(path.join(destination, "from-remote.txt"), "downloaded bytes", "utf8");
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const backend = await createOpenShellBackendFixture({
        workspaceDir: workspace.dir,
        mode: operation === "remote skills" ? "remote" : "mirror",
        ...(operation === "remote skills" ? { skillsWorkspaceDir: skills.dir } : {}),
      });
      const target =
        operation === "mirror write" || operation === "mirror stat"
          ? hostFile
          : operation === "shadow parent"
            ? path.dirname(shadowDirectory)
            : operation === "shadow directory"
              ? shadowDirectory
              : skills.dir;
      const failure = Object.assign(new Error(`synthetic ${operation} stat failure`), { code });
      const lstat = fs.lstat;
      let injected = false;
      const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        if (
          !injected &&
          String(args[0]) === target &&
          (operation !== "mirror write" ||
            (await fs.readFile(hostFile, "utf8")) === "new host bytes")
        ) {
          injected = true;
          throw failure;
        }
        return await lstat(...args);
      });
      try {
        let result: unknown;
        if (operation === "mirror write" || operation === "mirror stat") {
          const bridge = expectDefined(
            backend.createFsBridge?.({
              sandbox: createSandboxTestContext({
                overrides: {
                  backendId: "openshell",
                  workspaceDir: workspace.dir,
                  agentWorkspaceDir: workspace.dir,
                  workspaceAccess: "rw",
                  containerWorkdir: "/sandbox",
                  backend,
                },
              }),
            }),
            "OpenShell mirror filesystem bridge",
          );
          if (operation === "mirror stat") {
            await expect(bridge.stat({ filePath: "missing.txt" })).resolves.toBeNull();
            result = await bridge.stat({ filePath: "note.txt" }).catch((error: unknown) => error);
          } else {
            result = await bridge
              .writeFile({ filePath: "note.txt", data: "new host bytes" })
              .catch((error: unknown) => error);
          }
        } else if (operation === "remote skills") {
          result = await backend
            .runShellCommand({ script: "true" })
            .catch((error: unknown) => error);
        } else {
          result = await finalizeMirror(backend).catch((error: unknown) => error);
        }
        expect(injected).toBe(true);
        expect(result).toBe(failure);
        if (operation === "mirror write" || operation === "mirror stat") {
          await expect(fs.readFile(hostFile, "utf8")).resolves.toBe(
            operation === "mirror write" ? "new host bytes" : "old host bytes",
          );
          await expect(fs.readFile(remoteFile, "utf8")).resolves.toBe("existing remote bytes");
        } else if (operation === "remote skills") {
          await expect(fs.readFile(remoteSkillFile, "utf8")).resolves.toBe("last good skill view");
        } else {
          await expect(fs.readFile(shadowFile, "utf8")).resolves.toBe("host-only shadow");
          await expect(fs.readFile(hostFile, "utf8")).resolves.toBe("old host bytes");
          await expectPathMissing(path.join(workspace.dir, "from-remote.txt"));
        }
      } finally {
        lstatSpy.mockRestore();
      }
    },
  );
});
