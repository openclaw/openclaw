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
async function workspace() {
  const root = tempDirs.make("openclaw-at-host-");
  const file = (name: string) => path.join(root, name);
  const writeFile = (name: string, text: string) => fs.writeFile(file(name), text, "utf8");
  const expectFile = (name: string, text: string) =>
    expect(fs.readFile(file(name), "utf8")).resolves.toBe(text);
  await fs.mkdir(file("@notes"));
  await fs.mkdir(file("notes"));
  return { root, file, writeFile, expectFile };
}

describe("leading-@ host and mounted sandbox paths", () => {
  it.each([false, true])(
    "reads, writes and edits literal @ paths (workspaceOnly=%s)",
    async (workspaceOnly) => {
      const { root: workspaceDir, writeFile, expectFile } = await workspace();
      await writeFile("@existing.md", "literal original");
      await writeFile("existing.md", "sibling original");
      await writeFile("notes/new.md", "sibling child");
      await writeFile("reference.md", "reference");
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
    const { root: workspaceDir, file, writeFile, expectFile } = await workspace();
    await writeFile("notes/new.md", "sibling before\n");
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
    await expectFile("@notes/new.md", "literal before\n");

    await runPatch("at-patch-update", [
      "*** Update File: @notes/new.md",
      "@@",
      "-literal before",
      "+literal after",
    ]);
    await expectFile("@notes/new.md", "literal after\n");

    await runPatch("at-patch-delete", ["*** Delete File: @notes/new.md"]);
    await expect(fs.stat(file("@notes/new.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expectFile("notes/new.md", "sibling before\n");
  });
});
