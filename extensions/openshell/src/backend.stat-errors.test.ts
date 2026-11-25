import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
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

beforeAll(installOpenShellBackendMocks);
afterAll(uninstallOpenShellBackendMocks);
beforeEach(resetOpenShellBackendMocks);

const operations = ["write", "stat", "parent", "shadow", "skills"] as const;
const cases = ["EIO", "EACCES"].flatMap((code) =>
  operations.map((operation) => ({ code, operation })),
);
it.each(cases)(
  "preserves data after $operation stat fails with $code",
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
    const mirror = operation === "write" || operation === "stat";
    const contents = new Map([
      [hostFile, "old host bytes"],
      [remoteFile, "existing remote bytes"],
      [shadowFile, "host-only shadow"],
      [remoteSkillFile, "last good skill view"],
    ]);
    for (const [file, bytes] of contents) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, bytes, "utf8");
    }
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
      mode: operation === "skills" ? "remote" : "mirror",
      ...(operation === "skills" ? { skillsWorkspaceDir: skills.dir } : {}),
    });
    const target = mirror
      ? hostFile
      : {
          parent: path.dirname(shadowDirectory),
          shadow: shadowDirectory,
          skills: skills.dir,
        }[operation];
    const failure = Object.assign(new Error(`synthetic ${operation} stat failure`), { code });
    const lstat = fs.lstat;
    let injected = false;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (
        !injected &&
        String(args[0]) === target &&
        (operation !== "write" || (await fs.readFile(hostFile, "utf8")) === "new host bytes")
      ) {
        injected = true;
        throw failure;
      }
      return await lstat(...args);
    });
    try {
      let action: Promise<unknown>;
      if (mirror) {
        const bridge = expectDefined(
          backend.createFsBridge?.({
            sandbox: {
              workspaceDir: workspace.dir,
              agentWorkspaceDir: workspace.dir,
              workspaceAccess: "rw",
              containerWorkdir: "/sandbox",
              containerName: "openclaw-sbx-test",
              docker: {},
              backend,
            },
          }),
          "OpenShell mirror filesystem bridge",
        );
        if (operation === "stat") {
          await expect(bridge.stat({ filePath: "missing.txt" })).resolves.toBeNull();
          action = bridge.stat({ filePath: "note.txt" });
        } else {
          action = bridge.writeFile({ filePath: "note.txt", data: "new host bytes" });
        }
      } else if (operation === "skills") {
        action = backend.runShellCommand({ script: "true" });
      } else {
        action = finalizeMirror(backend);
      }
      await expect(action).rejects.toBe(failure);
      expect(injected).toBe(true);
      if (operation === "write") {
        contents.set(hostFile, "new host bytes");
      }
      const checked = mirror
        ? [hostFile, remoteFile]
        : operation === "skills"
          ? [remoteSkillFile]
          : [shadowFile, hostFile];
      for (const file of checked) {
        await expect(fs.readFile(file, "utf8")).resolves.toBe(contents.get(file));
      }
      if (!mirror && operation !== "skills") {
        await expectPathMissing(path.join(workspace.dir, "from-remote.txt"));
      }
    } finally {
      lstatSpy.mockRestore();
    }
  },
);
