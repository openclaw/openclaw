import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readMemoryArtifactProvenance } from "../memory/memory-artifact-provenance.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  createSandboxedEditTool,
  createSandboxedReadTool,
  createSandboxedWriteTool,
  wrapToolMemoryFlushAppendOnlyWrite,
  wrapToolWorkspaceRootGuardWithOptions,
} from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { extractResolvedApplyPatchTargetPaths } from "./apply-patch-paths.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { createMemoryWriteProvenanceObserver } from "./memory-write-provenance.js";
import { resolveSandboxFileIdentity } from "./sandbox/file-mutation-identity.js";
import { createRemoteShellSandboxFsBridge } from "./sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./sandbox/remote-fs-bridge.test-helpers.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";
import { createSandboxFsBridgeFromResolver } from "./test-helpers/host-sandbox-fs-bridge.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const patchInput = (lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const addFile = (file: string, text: string) => [`*** Add File: ${file}`, `+${text}`];
const deleteFile = (file: string) => `*** Delete File: ${file}`;
const updateFile = (file: string, oldText: string, newText: string, moveTo?: string) => [
  `*** Update File: ${file}`,
  ...(moveTo ? [`*** Move to: ${moveTo}`] : []),
  "@@",
  `-${oldText}`,
  `+${newText}`,
];

// GNU shell operations need Linux; the portable row runs the same scenario everywhere.
const fixtures = process.platform === "linux" ? ["portable", "Linux shell"] : ["portable"];
it.each(fixtures)("leading-@ remote paths (%s)", async (fixture) => {
  const stateDir = await fs.realpath(tempDirs.make("openclaw-at-remote-"));
  const hostRoot = path.join(stateDir, "host");
  const remoteRoot = path.join(stateDir, "remote");
  const containerWorkdir = fixture === "portable" ? "/remote-workspace" : remoteRoot;
  const remoteFile = (relativePath: string) => path.join(remoteRoot, relativePath);
  const expectFile = (relativePath: string, content: string) =>
    expect(fs.readFile(remoteFile(relativePath), "utf8")).resolves.toBe(content);
  const expectMissing = (relativePath: string, root = remoteRoot) =>
    expect(fs.stat(path.join(root, relativePath))).rejects.toMatchObject({ code: "ENOENT" });
  await fs.mkdir(hostRoot);
  await fs.mkdir(remoteRoot);
  for (const directory of ["@projects", "projects", "memory", "@memory"]) {
    await fs.mkdir(remoteFile(directory));
  }
  for (const [filePath, content] of Object.entries({
    "@notes.md": "literal original",
    "notes.md": "sibling original",
    "reference.md": "reference",
    "obsolete.md": "obsolete",
    "move-source.md": "move source",
    "@replace-absent.md": "old literal",
    "@replace-present.md": "old literal",
    "replace-present.md": "sibling",
    "projects/new.md": "sibling child",
  })) {
    await fs.writeFile(remoteFile(filePath), content, "utf8");
  }

  const sandbox = createSandboxTestContext({
    overrides: {
      workspaceDir: hostRoot,
      agentWorkspaceDir: hostRoot,
      containerWorkdir,
    },
  });
  const remoteBridge = createRemoteShellSandboxFsBridge({
    sandbox,
    runtime: {
      remoteWorkspaceDir: containerWorkdir,
      remoteAgentWorkspaceDir: containerWorkdir,
      runRemoteShellScript: createLocalRemoteShellScriptRunner(),
    },
  });
  const resolvePath = remoteBridge.resolvePath.bind(remoteBridge);
  const bridge =
    fixture === "portable"
      ? {
          ...createSandboxFsBridgeFromResolver((filePath, cwd) => {
            const resolved = resolvePath({ filePath, cwd });
            return { ...resolved, hostPath: path.join(remoteRoot, resolved.relativePath) };
          }, remoteBridge.pathMappings),
          // Keep public resolution remote; only backing operations may use host paths.
          resolvePath,
        }
      : remoteBridge;
  const patchSandbox = { root: hostRoot, bridge, workspaceMounts: bridge.pathMappings };
  const patchOptions = { cwd: hostRoot, sandbox: patchSandbox };
  let callId = 0;
  const invoke = (tool: AnyAgentTool, args: unknown) => tool.execute(`remote-${++callId}`, args);
  const patch = (
    lines: string[],
    options: Parameters<typeof createApplyPatchTool>[0] = patchOptions,
  ) => invoke(createApplyPatchTool(options), { input: patchInput(lines) });
  const guard = <TDetails>(tool: AnyAgentTool<TDetails>) =>
    wrapToolWorkspaceRootGuardWithOptions(tool, hostRoot, {
      containerWorkdir,
      bridge,
    });
  const readTool = guard(createSandboxedReadTool({ root: hostRoot, bridge }));
  const writeTool = guard(createSandboxedWriteTool({ root: hostRoot, bridge }));
  const editTool = guard(createSandboxedEditTool({ root: hostRoot, bridge }));
  const expectRead = (filePath: string, text: string) =>
    expect(invoke(readTool, { path: filePath })).resolves.toMatchObject({
      content: expect.arrayContaining([expect.objectContaining({ type: "text", text })]),
    });
  const write = (filePath: string, content: string, tool = writeTool) =>
    invoke(tool, { path: filePath, content });
  const edit = (filePath: string, oldText: string, newText: string, tool = editTool) =>
    invoke(tool, { path: filePath, edits: [{ oldText, newText }] });

  const statError = new Error("remote stat unavailable");
  const stat = bridge.stat.bind(bridge);
  const statFailure = vi.spyOn(bridge, "stat").mockImplementation((params) => {
    if (resolvePath(params).relativePath === "@notes.md") {
      return Promise.reject(statError);
    }
    return stat(params);
  });
  try {
    await expect(write("@notes.md", "must not replace either file")).rejects.toBe(statError);
    await expectFile("@notes.md", "literal original");
    await expectFile("notes.md", "sibling original");
  } finally {
    statFailure.mockRestore();
  }

  await expectRead("@notes.md", "literal original");
  await expectRead("@reference.md", "reference");
  await write("@notes.md", "literal updated");
  await edit("@notes.md", "updated", "edited");
  await expectFile("@notes.md", "literal edited");
  await expectFile("notes.md", "sibling original");
  await expectRead("@@notes.md", "literal edited");
  await write("@@notes.md", "referenced original");
  await edit("@@notes.md", "original", "edited");
  const referencedPatch = patchInput(
    updateFile("@@notes.md", "referenced edited", "referenced patched"),
  );
  await expect(
    extractResolvedApplyPatchTargetPaths(referencedPatch, patchOptions),
  ).resolves.toEqual([path.posix.join(containerWorkdir, "@notes.md")]);
  await invoke(createApplyPatchTool(patchOptions), { input: referencedPatch });
  await expectFile("@notes.md", "referenced patched");
  await expectFile("notes.md", "sibling original");
  await write("@projects/new.md", "literal child");
  await expectFile("@projects/new.md", "literal child");
  await expectFile("projects/new.md", "sibling child");

  const journal = "memory/2026-08-25.md";
  await fs.writeFile(remoteFile(journal), "allowed", "utf8");
  await fs.writeFile(remoteFile(`@${journal}`), "literal", "utf8");
  const memoryWriteTool = wrapToolMemoryFlushAppendOnlyWrite(writeTool, {
    root: hostRoot,
    relativePath: journal,
    sandbox: patchSandbox,
  });
  await expect(write(`@${journal}`, "wrong journal", memoryWriteTool)).rejects.toThrow(
    /Memory flush writes are restricted/,
  );
  await expectFile(journal, "allowed");

  await patch([deleteFile("@notes.md")]);
  await expectMissing("@notes.md");
  await expectFile("notes.md", "sibling original");
  await patch([
    ...updateFile("@reference.md", "reference", "reference patched"),
    ...addFile("@added.md", "added"),
    deleteFile("@obsolete.md"),
    ...updateFile("@move-source.md", "move source", "move target", "@moved.md"),
  ]);
  await expectFile("reference.md", "reference patched");
  await expectFile("added.md", "added\n");
  await expectMissing("obsolete.md");
  await expectMissing("move-source.md");
  await expectFile("moved.md", "move target");
  await patch([
    deleteFile("@replace-absent.md"),
    ...addFile("@replace-absent.md", "new literal"),
    deleteFile("@replace-present.md"),
    ...addFile("@replace-present.md", "new literal"),
  ]);
  await expectFile("@replace-absent.md", "new literal\n");
  await expectMissing("replace-absent.md");
  await expectFile("@replace-present.md", "new literal\n");
  await expectFile("replace-present.md", "sibling");
  await withStateDirEnv("openclaw-remote-provenance-", async () => {
    const relativePath = "memory/quarantine.md";
    const memoryPath = path.posix.join(containerWorkdir, relativePath);
    const memoryWriteProvenance = createMemoryWriteProvenanceObserver({
      mutationRoot: hostRoot,
      workspaceDir: hostRoot,
      resolvePath: (filePath) => resolveSandboxFileIdentity({ bridge, cwd: hostRoot, filePath }),
      resolveOriginClass: () => "untrusted",
    });
    const toolOptions = { root: hostRoot, bridge, memoryWriteProvenance };
    const memoryWrite = guard(createSandboxedWriteTool(toolOptions));
    const expectQuarantine = async (content: string) => {
      await expect(
        readMemoryArtifactProvenance({ workspaceDir: hostRoot, relativePath }),
      ).resolves.toMatchObject({
        originClass: "untrusted",
        fileHash: createHash("sha256").update(content).digest("hex"),
      });
      await expectFile(relativePath, content);
    };
    try {
      await write(memoryPath, "written", memoryWrite);
      await expectQuarantine("written");
      await edit(memoryPath, "written", "edited", guard(createSandboxedEditTool(toolOptions)));
      await expectQuarantine("edited");
      await patch(updateFile(memoryPath, "edited", "patched"), {
        ...patchOptions,
        memoryWriteProvenance,
      });
      await expectQuarantine("patched");
      await wrapToolMemoryFlushAppendOnlyWrite(memoryWrite, {
        root: hostRoot,
        relativePath,
        containerWorkdir,
        sandbox: patchSandbox,
        memoryWriteProvenance,
      }).execute("remote-memory-flush", { path: memoryPath, content: "flushed" });
      await expectQuarantine("patched\nflushed");
      if (fixture === "Linux shell") {
        await fs.symlink(remoteFile("memory"), remoteFile("journal-alias"));
        await write(
          path.posix.join(containerWorkdir, "journal-alias/quarantine.md"),
          "aliased",
          memoryWrite,
        );
        await expectQuarantine("aliased");
      }
    } finally {
      resetPluginStateStoreForTests();
    }
  });
  await expectMissing("@notes.md", hostRoot);
  await expect(fs.readdir(hostRoot)).resolves.toEqual([]);
});
