import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { extractResolvedApplyPatchTargetPaths } from "./apply-patch-paths.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { createMemoryWriteProvenanceObserver } from "./memory-write-provenance.js";
import { resolveSandboxFileIdentity } from "./sandbox/file-mutation-identity.js";
import { createRemoteShellSandboxFsBridge } from "./sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./sandbox/remote-fs-bridge.test-helpers.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";
import { createSandboxFsBridgeFromResolver } from "./test-helpers/host-sandbox-fs-bridge.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.each(["portable", "Linux shell"] as const)("leading-@ remote paths (%s)", (fixture) => {
  // The shell fixture runs remote GNU utilities locally; the portable fixture
  // exercises the same tool scenario without requiring that local environment.
  it.runIf(fixture === "portable" || process.platform === "linux")(
    "preserves literal files, shorthand, journal authority, patch targets, and stat failures",
    async () => {
      const stateDir = await fs.realpath(tempDirs.make("openclaw-at-remote-"));
      const hostRoot = path.join(stateDir, "host");
      const remoteRoot = path.join(stateDir, "remote");
      const containerWorkdir = fixture === "portable" ? "/remote-workspace" : remoteRoot;
      const remoteFile = (relativePath: string) => path.join(remoteRoot, relativePath);
      const expectFile = (relativePath: string, content: string) =>
        expect(fs.readFile(remoteFile(relativePath), "utf8")).resolves.toBe(content);
      const expectMissing = (relativePath: string) =>
        expect(fs.stat(remoteFile(relativePath))).rejects.toMatchObject({ code: "ENOENT" });
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
          workspaceAccess: "rw",
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
              // Only backing operations see hostPath. Public resolution must keep
              // path policy on asynchronous remote stat, including on Windows.
              resolvePath,
            }
          : remoteBridge;
      const patchSandbox = { root: hostRoot, bridge, workspaceMounts: bridge.pathMappings };
      const patchOptions = { cwd: hostRoot, sandbox: patchSandbox };
      const patch = (callId: string, lines: string[]) =>
        createApplyPatchTool(patchOptions).execute(callId, {
          input: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n"),
        });
      const guard = (tool: ReturnType<typeof createSandboxedReadTool>) =>
        wrapToolWorkspaceRootGuardWithOptions(tool, hostRoot, {
          containerWorkdir,
          bridge,
        });
      const readTool = guard(createSandboxedReadTool({ root: hostRoot, bridge }));
      const writeTool = guard(createSandboxedWriteTool({ root: hostRoot, bridge }));
      const editTool = guard(createSandboxedEditTool({ root: hostRoot, bridge }));

      const statError = new Error("remote stat unavailable");
      const stat = bridge.stat.bind(bridge);
      const statFailure = vi
        .spyOn(bridge, "stat")
        .mockImplementation((params) =>
          resolvePath(params).relativePath === "@notes.md"
            ? Promise.reject(statError)
            : stat(params),
        );
      try {
        await expect(
          writeTool.execute("remote-at-stat-error", {
            path: "@notes.md",
            content: "must not replace either file",
          }),
        ).rejects.toBe(statError);
        await expectFile("@notes.md", "literal original");
        await expectFile("notes.md", "sibling original");
      } finally {
        statFailure.mockRestore();
      }

      await expect(readTool.execute("remote-at-read", { path: "@notes.md" })).resolves.toEqual(
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "literal original" }),
          ]),
        }),
      );
      await expect(
        readTool.execute("remote-at-reference", { path: "@reference.md" }),
      ).resolves.toEqual(
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "reference" }),
          ]),
        }),
      );
      await writeTool.execute("remote-at-write", {
        path: "@notes.md",
        content: "literal updated",
      });
      await editTool.execute("remote-at-edit", {
        path: "@notes.md",
        edits: [{ oldText: "updated", newText: "edited" }],
      });
      await expectFile("@notes.md", "literal edited");
      await expectFile("notes.md", "sibling original");
      await expect(
        readTool.execute("remote-reference-literal-read", { path: "@@notes.md" }),
      ).resolves.toEqual(
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "literal edited" }),
          ]),
        }),
      );
      await writeTool.execute("remote-reference-literal-write", {
        path: "@@notes.md",
        content: "referenced original",
      });
      await editTool.execute("remote-reference-literal-edit", {
        path: "@@notes.md",
        edits: [{ oldText: "original", newText: "edited" }],
      });
      const referencedPatch = [
        "*** Begin Patch",
        "*** Update File: @@notes.md",
        "@@",
        "-referenced edited",
        "+referenced patched",
        "*** End Patch",
      ].join("\n");
      await expect(
        extractResolvedApplyPatchTargetPaths(referencedPatch, patchOptions),
      ).resolves.toEqual([path.posix.join(containerWorkdir, "@notes.md")]);
      await createApplyPatchTool(patchOptions).execute("remote-reference-literal-patch", {
        input: referencedPatch,
      });
      await expectFile("@notes.md", "referenced patched");
      await expectFile("notes.md", "sibling original");
      await writeTool.execute("remote-at-parent-write", {
        path: "@projects/new.md",
        content: "literal child",
      });
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
      await expect(
        memoryWriteTool.execute("remote-at-memory", {
          path: `@${journal}`,
          content: "wrong journal",
        }),
      ).rejects.toThrow(/Memory flush writes are restricted/);
      await expectFile(journal, "allowed");

      await patch("remote-at-patch", ["*** Delete File: @notes.md"]);
      await expectMissing("@notes.md");
      await expectFile("notes.md", "sibling original");
      await patch("remote-at-shorthand-patch", [
        "*** Update File: @reference.md",
        "@@",
        "-reference",
        "+reference patched",
        "*** Add File: @added.md",
        "+added",
        "*** Delete File: @obsolete.md",
        "*** Update File: @move-source.md",
        "*** Move to: @moved.md",
        "@@",
        "-move source",
        "+move target",
      ]);
      await expectFile("reference.md", "reference patched");
      await expectFile("added.md", "added\n");
      await expectMissing("obsolete.md");
      await expectMissing("move-source.md");
      await expectFile("moved.md", "move target");
      await patch("remote-at-replace-patch", [
        "*** Delete File: @replace-absent.md",
        "*** Add File: @replace-absent.md",
        "+new literal",
        "*** Delete File: @replace-present.md",
        "*** Add File: @replace-present.md",
        "+new literal",
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
          resolvePath: (filePath) =>
            resolveSandboxFileIdentity({ bridge, cwd: hostRoot, filePath }),
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
          await memoryWrite.execute("remote-memory-write", {
            path: memoryPath,
            content: "written",
          });
          await expectQuarantine("written");
          await guard(createSandboxedEditTool(toolOptions)).execute("remote-memory-edit", {
            path: memoryPath,
            edits: [{ oldText: "written", newText: "edited" }],
          });
          await expectQuarantine("edited");
          await createApplyPatchTool({
            cwd: hostRoot,
            sandbox: patchSandbox,
            memoryWriteProvenance,
          }).execute("remote-memory-patch", {
            input: [
              "*** Begin Patch",
              `*** Update File: ${memoryPath}`,
              "@@",
              "-edited",
              "+patched",
              "*** End Patch",
            ].join("\n"),
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
            await memoryWrite.execute("remote-memory-alias", {
              path: path.posix.join(containerWorkdir, "journal-alias/quarantine.md"),
              content: "aliased",
            });
            await expectQuarantine("aliased");
          }
        } finally {
          resetPluginStateStoreForTests();
        }
      });
      await expect(fs.stat(path.join(hostRoot, "@notes.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.readdir(hostRoot)).resolves.toEqual([]);
    },
  );
});
