import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSandbox,
  createSandboxFsBridge,
  findCallByDockerArg,
  getDockerArg,
  installFsBridgeTestHarness,
  mockedExecDockerRaw,
  withTempDir,
} from "./fs-bridge.test-helpers.js";

describe("sandbox fs bridge anchored ops", () => {
  installFsBridgeTestHarness();

  const pinnedReadCases = [
    {
      name: "workspace reads use pinned file descriptors",
      filePath: "notes/todo.txt",
      contents: "todo",
      setup: async (workspaceDir: string) => {
        await fs.mkdir(path.join(workspaceDir, "notes"), { recursive: true });
        await fs.writeFile(path.join(workspaceDir, "notes", "todo.txt"), "todo");
      },
      sandbox: (workspaceDir: string) =>
        createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
    },
    {
      name: "bind-mounted reads use pinned file descriptors",
      filePath: "/workspace-two/README.md",
      contents: "bind-read",
      setup: async (workspaceDir: string, stateDir: string) => {
        const bindRoot = path.join(stateDir, "workspace-two");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(bindRoot, { recursive: true });
        await fs.writeFile(path.join(bindRoot, "README.md"), "bind-read");
      },
      sandbox: (workspaceDir: string, stateDir: string) =>
        createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          docker: {
            ...createSandbox().docker,
            binds: [`${path.join(stateDir, "workspace-two")}:/workspace-two:ro`],
          },
        }),
    },
  ] as const;

  it.each(pinnedReadCases)("$name", async (testCase) => {
    await withTempDir("openclaw-fs-bridge-contract-read-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await testCase.setup(workspaceDir, stateDir);
      const bridge = createSandboxFsBridge({
        sandbox: testCase.sandbox(workspaceDir, stateDir),
      });

      await expect(bridge.readFile({ filePath: testCase.filePath })).resolves.toEqual(
        Buffer.from(testCase.contents),
      );
      expect(mockedExecDockerRaw).not.toHaveBeenCalled();
    });
  });

  const anchoredCases = [
    {
      name: "mkdirp pins mount root + relative parent + basename",
      invoke: (bridge: ReturnType<typeof createSandboxFsBridge>) =>
        bridge.mkdirp({ filePath: "nested/leaf" }),
      op: "mkdirp",
      expectedArgs: ["/workspace", "nested", "leaf"],
      forbiddenArgs: ["/workspace/nested/leaf", "/workspace/nested"],
    },
    {
      name: "remove pins mount root + relative parent + basename",
      invoke: (bridge: ReturnType<typeof createSandboxFsBridge>) =>
        bridge.remove({ filePath: "nested/file.txt" }),
      op: "remove",
      expectedArgs: ["/workspace", "nested", "file.txt", "0", "1"],
      forbiddenArgs: ["/workspace/nested/file.txt", "/workspace/nested"],
    },
    {
      name: "rename pins both parents + basenames",
      invoke: (bridge: ReturnType<typeof createSandboxFsBridge>) =>
        bridge.rename({ from: "from.txt", to: "nested/to.txt" }),
      op: "rename",
      expectedArgs: ["/workspace", "", "from.txt", "/workspace", "nested", "to.txt"],
      forbiddenArgs: ["/workspace/from.txt", "/workspace/nested/to.txt", "/workspace/nested"],
    },
  ] as const;

  it.each(anchoredCases)("$name", async (testCase) => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });

    await testCase.invoke(bridge);

    const opCall = findCallByDockerArg(1, testCase.op);
    expect(opCall).toBeDefined();
    const args = opCall?.[0] ?? [];
    testCase.expectedArgs.forEach((value, index) => {
      expect(getDockerArg(args, index + 2)).toBe(value);
    });
    testCase.forbiddenArgs.forEach((value) => {
      expect(args).not.toContain(value);
    });
  });
});
