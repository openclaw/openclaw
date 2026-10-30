import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import * as logger from "../logger.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";

vi.mock("../infra/shell-env.js", async () => {
  const mod =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
  return { ...mod, getShellPathFromLoginShell: () => null };
});

const fileTools = ["write", "read", "edit", "apply_patch"] as const;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let parent: string, root: string, outside: string, alias: string;
beforeEach(async () => {
  setRuntimeConfigSnapshot({});
  parent = await fs.realpath(tempDirs.make("openclaw-permissions-"));
  root = path.join(parent, "workspace");
  outside = path.join(parent, "outside.txt");
  alias = path.join(parent, "workspace-alias");
  await fs.mkdir(path.join(root, "packages/app"), { recursive: true });
  await fs.writeFile(outside, "original\n");
});
afterEach(() => clearRuntimeConfigSnapshot());
function args(name: (typeof fileTools)[number], target: string) {
  if (name === "apply_patch") {
    return {
      input: `*** Begin Patch\n*** Update File: ${target}\n@@\n-original\n+changed\n*** End Patch`,
    };
  }
  if (name === "edit") {
    return { path: target, edits: [{ oldText: "original", newText: "changed" }] };
  }
  return name === "write" ? { path: target, content: "changed\n" } : { path: target };
}
type ToolOptions = NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;
type PermissionMode = NonNullable<ToolOptions["sessionPermissionPolicy"]>["mode"];
function toolsFor(mode: PermissionMode, options: ToolOptions = {}) {
  return createOpenClawCodingTools({
    workspaceDir: root,
    sessionPermissionPolicy: { root, mode },
    ...options,
  });
}
function tool(name: string, mode: PermissionMode, options: ToolOptions = {}) {
  return findTool(toolsFor(mode, options), name);
}
const findTool = (tools: ReturnType<typeof createOpenClawCodingTools>, name: string) =>
  expectDefined(
    tools.find((entry) => entry.name === name),
    name,
  );
const expectFile = (target: string, content = "original\n") =>
  expect(fs.readFile(target, "utf8")).resolves.toBe(content);
async function originalFile(relativePath = "proof.txt") {
  const target = path.join(root, relativePath);
  await fs.writeFile(target, "original\n");
  return target;
}
const readText = async (read: ReturnType<typeof findTool>, target: string) =>
  getTextContent(await read.execute("read", { path: target }));
const expectDenied = (result: Promise<unknown>, reason = /sandbox root/i) =>
  expect(result).rejects.toThrow(reason);
let nextCall = 0;
const run = (operation: ReturnType<typeof findTool>, input: unknown) =>
  operation.execute(`permission-${++nextCall}`, input);
const addFile = (target: string) => ({
  input: `*** Begin Patch\n*** Add File: ${target}\n+created\n*** End Patch`,
});
function aliasTools(mode: PermissionMode = "guarded") {
  return toolsFor(mode, { workspaceDir: alias, cwd: alias });
}

it("logs required-root containment without exposing policy advice in full mode", async () => {
  const patch = tool("apply_patch", "full", {
    requireWorkspaceOnly: true,
    config: {
      tools: { fs: { workspaceOnly: false }, exec: { applyPatch: { workspaceOnly: false } } },
    },
  });
  const definition = expectDefined(toToolDefinitions([patch])[0], "patch definition");
  // The core tool does not consume extension context.
  const context = {} as Parameters<typeof definition.execute>[4];
  const logError = vi.spyOn(logger, "logError").mockImplementation(() => {});
  try {
    const result = await definition.execute(
      "required-root",
      args("apply_patch", outside),
      undefined,
      undefined,
      context,
    );
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("required workspace root"));
    expect(logError.mock.calls[0]?.[0]).not.toContain("Only a full");
    expect(result.details).toEqual({
      status: "error",
      tool: "apply_patch",
      error:
        `Path escapes sandbox root (${root}): ${outside}. Keep patch paths within the bound root. ` +
        "For an authorized task in another repository, ask the parent to respawn the worker with " +
        "sessions_spawn and cwd set to that repository. Changing exec workdir does not rebind file tools.",
    });
    await expectFile(outside);
  } finally {
    logError.mockRestore();
  }
});

describe.runIf(process.platform !== "win32")("trusted workspace aliases", () => {
  beforeEach(async () => {
    await fs.symlink(root, alias, "dir");
    await expect(fs.realpath(alias)).resolves.toBe(root);
  });
  it.each(["write", "read", "edit"] as const)(
    "allows %s within the canonical root",
    async (name) => {
      const target = await originalFile();
      const operation = tool(name, "guarded", {
        workspaceDir: alias,
        cwd: path.join(alias, "packages/app"),
      });
      const result = await operation.execute(
        "alias",
        args(name, name === "read" ? path.join(alias, "proof.txt") : "../../proof.txt"),
      );
      if (name === "read") {
        expect(getTextContent(result)).toBe("original\n");
      }
      await expectFile(target, name === "read" ? "original\n" : "changed\n");
    },
  );

  it("allows read-only alias reads while excluding mutations and outside files", async () => {
    await originalFile();
    const tools = aliasTools("read-only");
    const names = tools.map((entry) => entry.name);
    expect(names).toContain("exec");
    for (const name of ["write", "edit", "apply_patch"]) {
      expect(names).not.toContain(name);
    }
    const read = findTool(tools, "read");
    expect(await readText(read, "proof.txt")).toBe("original\n");
    await expectDenied(read.execute("outside", { path: outside }));
  });

  it("denies unrelated external aliases pointing into the root", async () => {
    const inside = await originalFile();
    const tools = aliasTools();
    for (const untrusted of [path.join(parent, "external-alias"), `${alias}-untrusted`]) {
      await fs.symlink(root, untrusted, "dir");
      const target = path.join(untrusted, "proof.txt");
      await expect(fs.realpath(target)).resolves.toBe(inside);
      for (const name of fileTools) {
        const operation = findTool(tools, name);
        await expectDenied(run(operation, args(name, target)), /escapes sandbox root/i);
        await expectFile(inside);
      }
    }
  });

  it("keeps missing daily memory optional through the alias", async () => {
    const read = tool("read", "guarded", { workspaceDir: alias });
    expect((await read.execute("memory", { path: "memory/2026-08-27.md" })).details).toMatchObject({
      kind: "not_found",
      optional: true,
    });
  });

  it("retains patch creation parent checks through trusted aliases", async () => {
    await fs.mkdir(path.join(root, "real"));
    await fs.symlink(path.join(root, "real"), path.join(root, "link"), "dir");
    const patch = findTool(aliasTools(), "apply_patch");
    for (const target of [path.join(root, "link/new.txt"), path.join(alias, "link/new.txt")]) {
      await expect(run(patch, addFile(target))).rejects.toMatchObject({
        name: "FsSafeError",
        code: "symlink",
      });
    }
    await expect(fs.readdir(path.join(root, "real"))).resolves.toEqual([]);
    await run(patch, addFile(`${alias}/new/proof.txt`));
    await expectFile(path.join(root, "new/proof.txt"), "created\n");
  });

  it.each(["../outside/proof.txt", "escape.txt", "sub/up/../outside/proof.txt"])(
    "denies escape %s without changing either target",
    async (relativeEscape) => {
      const escapedFile = path.join(parent, "outside/proof.txt");
      const decoy = path.join(root, "sub/outside/proof.txt");
      for (const target of [escapedFile, decoy]) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, "original\n");
      }
      await fs.symlink(escapedFile, path.join(root, "escape.txt"));
      await fs.symlink("..", path.join(root, "sub/up"), "dir");
      // Preserve raw '..' bytes: native traversal escapes while normalization hits the decoy.
      const canonicalInput = `${root}/${relativeEscape}`;
      await expect(fs.realpath(canonicalInput)).resolves.toBe(escapedFile);
      const tools = aliasTools();
      for (const name of fileTools) {
        const operation = findTool(tools, name);
        for (const input of [canonicalInput, relativeEscape]) {
          await expectDenied(
            run(operation, args(name, input)),
            /(?:escapes|outside) sandbox root/i,
          );
          await expectFile(escapedFile);
          await expectFile(decoy);
        }
      }
      await expect(fs.readlink(path.join(root, "escape.txt"))).resolves.toBe(escapedFile);
    },
  );
});

it("separates a nested session cwd from its workspace permission boundary", async () => {
  const tools = toolsFor("workspace", { cwd: path.join(root, "packages/app") });
  const read = findTool(tools, "read");
  const write = findTool(tools, "write");
  const patch = findTool(tools, "apply_patch");
  await originalFile("shared.txt");
  expect(await readText(read, "../../shared.txt")).toBe("original\n");
  await write.execute("nested", { path: "../../created.txt", content: "created" });
  await expectFile(path.join(root, "created.txt"), "created");
  await patch.execute("nested", args("apply_patch", "../../shared.txt"));
  await expectFile(path.join(root, "shared.txt"), "changed\n");
  await expectDenied(read.execute("outside", { path: outside }));
});

it("denies exec when a turn tightens the dispatch-provided full mode", async () => {
  const exec = tool("exec", "full", {
    exec: { host: "gateway", mode: "full", security: "deny", ask: "off" },
  });
  await expectDenied(run(exec, { command: "echo exec-policy-proof" }), /security=deny/);
});

it.each([undefined, true] as const)(
  "confines full-mode directory listing when required=%s",
  async (required) => {
    const ls = tool("ls", "full", { requireWorkspaceOnly: required });
    expect(getTextContent(await ls.execute("inside", { path: "." }))).toBe('"packages/"');
    if (required) {
      await expectDenied(ls.execute("outside", { path: parent }));
    } else {
      expect(await readText(ls, parent)).toContain("outside.txt");
    }
  },
);

it.each([
  ["write", true],
  ["write", undefined],
  ["apply_patch", undefined],
] as const)("preserves full-mode %s authority with required root=%s", async (name, required) => {
  const inside = await originalFile();
  const operation = tool(name, "full", { requireWorkspaceOnly: required });
  await operation.execute("inside", args(name, inside));
  await expectFile(inside, "changed\n");
  if (required) {
    await expectDenied(operation.execute("outside", args(name, outside)));
    await expectFile(outside);
  } else {
    await operation.execute("outside", args(name, outside));
    await expectFile(outside, "changed\n");
  }
});
