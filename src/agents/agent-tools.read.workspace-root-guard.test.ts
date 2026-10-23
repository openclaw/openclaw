import path from "node:path";
import { Type } from "typebox";
import { beforeEach, expect, it, vi } from "vitest";
import {
  createOpenClawReadTool,
  wrapToolWorkspaceRootGuardWithOptions,
} from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import type { ReadToolDetails } from "./sessions/tools/tool-contracts.js";
import { createSandboxFsBridgeFromResolver } from "./test-helpers/host-sandbox-fs-bridge.js";

type AssertSandboxPath = typeof import("./sandbox-paths.js").assertSandboxPath;
const mocks = vi.hoisted(() => ({ assertSandboxPath: vi.fn<AssertSandboxPath>() }));
vi.mock("./sandbox-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-paths.js")>()),
  assertSandboxPath: mocks.assertSandboxPath,
}));
const root = path.resolve("/tmp/root");
const execute = vi.fn(async () => ({
  content: [{ type: "text" as const, text: "ok" }],
  details: { kind: "text" as const, content: "ok" },
}));
let tool: AnyAgentTool<ReadToolDetails>;
const guard = (
  filePath: string,
  options?: Parameters<typeof wrapToolWorkspaceRootGuardWithOptions>[2],
) => wrapToolWorkspaceRootGuardWithOptions(tool, root, options).execute("path", { path: filePath });
function expectGuard(filePath: string, guardRoot = root) {
  expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
    filePath,
    cwd: guardRoot,
    root: guardRoot,
  });
}
beforeEach(() => {
  execute.mockClear();
  tool = { name: "read", label: "read", description: "read", parameters: Type.Object({}), execute };
  mocks.assertSandboxPath.mockReset().mockImplementation(async ({ filePath }) => ({
    resolved:
      filePath.startsWith("file://") || path.isAbsolute(filePath)
        ? filePath
        : path.resolve(root, filePath),
    relative: "",
  }));
});

it.each([
  ["@/workspace/docs/readme.md</arg_value>>", path.resolve(root, "docs/readme.md")],
  ["file://attacker/share/readme.md", "file://attacker/share/readme.md"],
  ["file:///workspace/%E0%A4%A", "file:///workspace/%E0%A4%A"],
  ["file:///workspace/%2FREADME.md", "file:///workspace/%2FREADME.md"],
  ["/workspace-two/secret.txt", "/workspace-two/secret.txt"],
])("guards normalized path %s", async (input, expected) => {
  await guard(input, { containerWorkdir: "/workspace", normalizeGuardedPathParams: true });
  expectGuard(expected);
  expect(execute).toHaveBeenCalledWith("path", { path: expected }, undefined, undefined);
});

it("adds a workspace-safe hint without executing a rejected path", async () => {
  mocks.assertSandboxPath.mockRejectedValueOnce(
    new Error("Path escapes sandbox root (/tmp/root): /tmp/meta.jsonl"),
  );
  await expect(guard("/tmp/meta.jsonl")).rejects.toThrow(
    /Path escapes sandbox root .* Use a relative path under `.openclaw\/tmp\/` inside the workspace/,
  );
  expect(execute).not.toHaveBeenCalled();
});

it("normalizes traversal before selecting an overlapping mount", async () => {
  await guard("/workspace/skills/../README.md", {
    containerMounts: [
      { containerRoot: "/workspace/skills", hostRoot: path.resolve("/tmp/skill-root") },
      { containerRoot: "/workspace", hostRoot: root },
    ],
    containerWorkdir: "/workspace",
  });
  expectGuard(path.resolve(root, "README.md"));
});

it("guards a file URL against its additional mount root", async () => {
  const agentRoot = path.resolve("/tmp/agent-root");
  await guard("file:///agent/docs/readme.md", {
    containerMounts: [{ containerRoot: "/agent", hostRoot: agentRoot }],
    containerWorkdir: "/workspace",
  });
  expectGuard(path.resolve(agentRoot, "docs/readme.md"), agentRoot);
});

it.each(["legacy", "miss", "mapped"] as const)(
  "honors %s bridge admission without inferring a namespace",
  async (mode) => {
    const mapping = { hostRoot: root, containerRoot: "C:\\NativeWorkspace" };
    const hostPath = path.join(root, "note.txt");
    const containerPath = mode === "miss" ? "C:\\Other\\note.txt" : "C:\\NativeWorkspace\\note.txt";
    const bridge = createSandboxFsBridgeFromResolver(
      () => ({ hostPath, relativePath: "note.txt", containerPath }),
      mode === "legacy" ? undefined : [mapping],
    );
    const running = guard("note.txt", {
      bridge,
      containerWorkdir: "C:\\NativeWorkspace",
      normalizeGuardedPathParams: true,
    });
    if (mode === "miss") {
      await expect(running).rejects.toThrow("Path escapes sandbox root");
      expect(execute).not.toHaveBeenCalled();
      expect(mocks.assertSandboxPath).not.toHaveBeenCalled();
      return;
    }
    await running;
    expectGuard(mode === "legacy" ? "note.txt" : hostPath);
    const forwardedPath = mode === "legacy" ? hostPath : containerPath;
    expect(execute).toHaveBeenCalledWith("path", { path: forwardedPath }, undefined, undefined);
  },
);

it.each(["guard", "read"])("%s rejects paths emptied by suffix stripping", async (wrapper) => {
  const guarded = wrapper === "guard";
  const wrapped = guarded
    ? wrapToolWorkspaceRootGuardWithOptions(tool, root, { pathParamKeys: ["outPath"] })
    : createOpenClawReadTool(tool);
  await expect(
    wrapped.execute("empty", { [guarded ? "outPath" : "path"]: "</arg_value>>" }),
  ).rejects.toThrow(
    guarded ? /Malformed path parameter: outPath/ : /Missing required parameter: path/,
  );
  expect(mocks.assertSandboxPath).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});
it("repairs Office paths and strips XML suffixes before reading", async () => {
  await createOpenClawReadTool(tool).execute("read", {
    path: "reports/final.docodex</arg_value>>",
  });
  expect(execute).toHaveBeenCalledWith(
    "read",
    { path: "reports/final.docx", offset: 1 },
    undefined,
  );
});
