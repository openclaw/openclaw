import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { expectReadWriteEditTools, getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";
import { createContainerWorkspaceSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("leading-@ host and mounted sandbox paths", () => {
  it.each([false, true])(
    "preserves literal files, new descendants, and file-reference shorthand with workspaceOnly=%s",
    async (workspaceOnly) => {
      const workspaceDir = tempDirs.make("openclaw-at-host-");
      const literalPath = path.join(workspaceDir, "@existing.md");
      const siblingPath = path.join(workspaceDir, "existing.md");
      const literalParent = path.join(workspaceDir, "@notes");
      const siblingParent = path.join(workspaceDir, "notes");
      const file = (name: string) => path.join(workspaceDir, name);
      const expectFile = (name: string, text: string) =>
        expect(fs.readFile(file(name), "utf8")).resolves.toBe(text);
      await fs.mkdir(literalParent);
      await fs.mkdir(siblingParent);
      await fs.writeFile(literalPath, "literal original", "utf8");
      await fs.writeFile(siblingPath, "sibling original", "utf8");
      await fs.writeFile(path.join(siblingParent, "new.md"), "sibling child", "utf8");
      await fs.writeFile(path.join(workspaceDir, "reference.md"), "reference", "utf8");
      const { readTool, writeTool, editTool } = expectReadWriteEditTools(
        createOpenClawCodingTools({
          workspaceDir,
          config: { tools: { fs: { workspaceOnly } } },
        }),
      );
      let callId = 0;
      const read = async (filePath: string, text: string) =>
        expect(
          getTextContent(await readTool.execute(`read-${++callId}`, { path: filePath })),
        ).toContain(text);
      const write = (filePath: string, content: string) =>
        writeTool.execute(`write-${++callId}`, { path: filePath, content });
      const edit = (filePath: string, oldText: string, newText: string) =>
        editTool.execute(`edit-${++callId}`, { path: filePath, edits: [{ oldText, newText }] });

      await read("@existing.md", "literal original");
      await read("@reference.md", "reference");
      await write("@existing.md", "literal updated");
      await edit("@existing.md", "updated", "edited");
      await write("@notes/nested/../new.md", "literal child");
      await expectFile("@existing.md", "literal edited");
      await expectFile("existing.md", "sibling original");
      await expectFile("@notes/new.md", "literal child");
      await expectFile("notes/new.md", "sibling child");
      await read("@@existing.md", "literal edited");
      await write("@@existing.md", "referenced original");
      await edit("@@existing.md", "original", "edited");
      await expectFile("@existing.md", "referenced edited");
      await expectFile("existing.md", "sibling original");
    },
  );

  it.each([
    { name: "workspace-confined host", workspaceOnly: true, mounted: false },
    { name: "unconfined host", workspaceOnly: false, mounted: false },
    { name: "mounted sandbox", workspaceOnly: true, mounted: true },
  ])("adds, updates, and deletes literal paths through the $name owner", async (runtime) => {
    const workspaceDir = tempDirs.make("openclaw-at-host-");
    const literalParent = path.join(workspaceDir, "@notes");
    const siblingParent = path.join(workspaceDir, "notes");
    const expectLiteral = (text: string) =>
      expect(fs.readFile(path.join(literalParent, "new.md"), "utf8")).resolves.toBe(text);
    await fs.mkdir(literalParent);
    await fs.mkdir(siblingParent);
    await fs.writeFile(path.join(siblingParent, "new.md"), "sibling before\n", "utf8");
    const patchTool = createApplyPatchTool({
      cwd: workspaceDir,
      workspaceOnly: runtime.workspaceOnly,
      ...(runtime.mounted
        ? {
            sandbox: {
              root: workspaceDir,
              bridge: createContainerWorkspaceSandboxFsBridge(workspaceDir),
              workspaceMounts: [{ containerRoot: "/workspace", hostRoot: workspaceDir }],
            },
          }
        : {}),
    });
    const runPatch = (callId: string, lines: string[]) =>
      patchTool.execute(callId, {
        input: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n"),
      });

    await runPatch("at-patch-add", ["*** Add File: @notes/new.md", "+literal before"]);
    await expectLiteral("literal before\n");

    await runPatch("at-patch-update", [
      "*** Update File: @notes/new.md",
      "@@",
      "-literal before",
      "+literal after",
    ]);
    await expectLiteral("literal after\n");

    await runPatch("at-patch-delete", ["*** Delete File: @notes/new.md"]);
    await expect(fs.stat(path.join(literalParent, "new.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(path.join(siblingParent, "new.md"), "utf8")).resolves.toBe(
      "sibling before\n",
    );
  });
});
