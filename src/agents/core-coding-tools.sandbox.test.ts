import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createCoreCodingTools } from "./core-coding-tools.js";
import { createMemoryWriteProvenanceObserver } from "./memory-write-provenance.js";
import { resolveSandboxFileIdentity } from "./sandbox/file-mutation-identity.js";
import {
  createSandbox,
  createSandboxFsBridge,
  installFsBridgeTestHarness,
  mockContainerCanonicalPaths,
  withTempDir,
} from "./sandbox/fs-bridge.test-helpers.js";
import { getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";
import { createSandboxFsBridgeFromResolver } from "./test-helpers/host-sandbox-fs-bridge.js";

function installLocalTransport(bridge: ReturnType<typeof createSandboxFsBridge>) {
  const local = createSandboxFsBridgeFromResolver((filePath, cwd) =>
    bridge.resolvePath({ filePath, cwd }),
  );
  // Replace only byte transport; retain guards, pinned reads, and session readback verification.
  const write = vi
    .spyOn(bridge, "writeFile")
    .mockImplementation((params) => local.writeFile(params));
  vi.spyOn(bridge, "createFileExclusive").mockImplementation((params) =>
    local.createFileExclusive!(params),
  );
  vi.spyOn(bridge, "remove").mockImplementation((params) => local.remove(params));
  vi.spyOn(bridge, "mkdirp").mockImplementation((params) => local.mkdirp(params));
  vi.spyOn(bridge, "stat").mockImplementation((params) => local.stat(params));
  const list = vi.spyOn(bridge, "readDirectory").mockImplementation(async (params) => {
    const { hostPath } = bridge.resolvePath(params);
    const entries = await fs.readdir(hostPath!, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  });
  return { write, list };
}

function createSandboxCodingTools(
  sandbox: ReturnType<typeof createSandbox>,
  options: Partial<Parameters<typeof createCoreCodingTools>[0]>,
) {
  const tools = createCoreCodingTools({
    codingRoot: sandbox.workspaceDir,
    containmentRoot: sandbox.workspaceDir,
    includeBaseCodingTools: true,
    shellTools: "disabled",
    readOnly: false,
    applyPatchEnabled: false,
    applyPatchWorkspaceOnly: true,
    workspaceOnly: true,
    execDefaults: {},
    processDefaults: {},
    ...options,
    sandbox,
  });
  const execute = (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) {
      throw new Error(`Missing ${name} tool`);
    }
    return tool.execute(name, args);
  };
  return {
    execute,
    text: async (name: string, filePath: string) =>
      getTextContent(await execute(name, { path: filePath })),
    edit: (filePath: string, oldText: string, newText: string) =>
      execute("edit", { path: filePath, edits: [{ oldText, newText }] }),
    patch: (input: string) => execute("apply_patch", { input }),
  };
}

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
}
const linkDirectory = (target: string, link: string) =>
  fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");

function mountSandbox(workspaceDir: string, binds: string[] = [], tmpfs?: string[]) {
  const sandbox = createSandbox({
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    workspaceAccess: "rw",
    docker: { ...createSandbox().docker, binds, ...(tmpfs ? { tmpfs } : {}) },
  });
  const bridge = createSandboxFsBridge({ sandbox });
  sandbox.fsBridge = bridge;
  return { sandbox, bridge };
}

const expectFile = async (root: string, file: string, text: string) => {
  expect(await fs.readFile(path.join(root, file), "utf8")).toBe(text);
};
const updatePatch = (file: string, before: string, after: string, moveTo?: string) =>
  `*** Begin Patch
*** Update File: ${file}
${moveTo ? `*** Move to: ${moveTo}\n` : ""}@@
-${before}
+${after}
*** End Patch`;

installFsBridgeTestHarness();

it.runIf(process.platform !== "win32").each([true, false])(
  "keeps literal backslash read/write/edit/patch targets distinct with workspaceOnly=%s",
  (workspaceOnly) =>
    withTempDir("openclaw-coding-mounts-", async (workspaceDir) => {
      await writeFiles(workspaceDir, { "a\\b": "LITERAL_ORIGINAL\n", "a/b": "SLASH_DECOY\n" });
      const { sandbox, bridge } = mountSandbox(workspaceDir);
      installLocalTransport(bridge);
      const { execute, text, edit, patch } = createSandboxCodingTools(sandbox, {
        shellTools: "full",
        workspaceOnly,
        applyPatchEnabled: true,
        applyPatchWorkspaceOnly: workspaceOnly,
      });
      for (const filePath of ["a\\b", "/workspace/a\\b"]) {
        const result = await text("read", filePath);
        expect(result).toContain("LITERAL_ORIGINAL");
        expect(result).not.toContain("SLASH_DECOY");
      }
      await execute("write", { path: "a\\b", content: "LITERAL_WRITTEN\n" });
      await edit("a\\b", "LITERAL_WRITTEN", "LITERAL_EDITED");
      await patch(updatePatch("a\\b", "LITERAL_EDITED", "LITERAL_PATCHED"));
      await expectFile(workspaceDir, "a\\b", "LITERAL_PATCHED\n");
      await expectFile(workspaceDir, "a/b", "SLASH_DECOY\n");
    }),
);

it.runIf(process.platform !== "win32").each([true, false])(
  "reads mapped aliases through real access and queue checks with workspaceOnly=%s",
  (workspaceOnly) =>
    withTempDir("openclaw-coding-mounts-", async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const replacement = path.join(root, "replacement");
      const hiddenContent = "HIDDEN_ORIGINAL_SYMLINK_BYTES";
      const visibleContent = "VISIBLE_CONTAINER_BIND_BYTES";
      await fs.mkdir(path.join(workspaceDir, "cache"), { recursive: true });
      await fs.mkdir(replacement);
      await fs.writeFile(path.join(workspaceDir, "visible.txt"), hiddenContent);
      await fs.symlink("../visible.txt", path.join(workspaceDir, "cache/hop"));
      await fs.symlink("cache/hop", path.join(workspaceDir, "alias"));
      await fs.symlink("/data/hop", path.join(workspaceDir, "absolute-alias"));
      await fs.writeFile(path.join(replacement, "hop"), visibleContent);
      const { sandbox } = mountSandbox(workspaceDir, [
        `${replacement}:/workspace/cache:rw`,
        `${replacement}:/data:rw`,
      ]);
      mockContainerCanonicalPaths({
        "/workspace/alias": "/workspace/cache/hop",
        "/workspace/absolute-alias": "/data/hop",
      });
      const { execute, text } = createSandboxCodingTools(sandbox, { workspaceOnly });
      for (const filePath of ["alias", "absolute-alias", "/data/hop"]) {
        const result = await text("read", filePath);
        expect(result).toContain(visibleContent);
        expect(result).not.toContain(hiddenContent);
      }
      if (workspaceOnly) {
        for (const name of ["write", "edit", "ls"]) {
          await expect(
            execute(name, {
              path: "/data/hop",
              content: "changed",
              oldText: visibleContent,
              newText: "changed",
            }),
          ).rejects.toThrow("Path escapes sandbox root");
        }
      }
      await expectFile(workspaceDir, "visible.txt", hiddenContent);
      await expectFile(replacement, "hop", visibleContent);
    }),
);

it.each([true, false])(
  "preserves container execution paths with workspaceOnly=%s",
  (workspaceOnly) =>
    withTempDir("openclaw-coding-mounts-", async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const replacement = path.join(root, "replacement");
      const outside = path.join(root, "outside");
      const data = path.join(root, "data");
      await fs.mkdir(workspaceDir);
      await writeFiles(root, {
        "replacement/sub/marker": "VISIBLE",
        "replacement/@literal": "AT",
        "replacement/literal": "DECOY",
        "replacement/@directory/literal-marker": "AT",
        "replacement/directory/decoy-marker": "DECOY",
        "outside/marker": "HIDDEN",
        "data/marker": "EXTRA",
      });
      await fs.mkdir(path.join(replacement, "cache"));
      await linkDirectory(outside, path.join(workspaceDir, "sub"));
      await linkDirectory(outside, path.join(replacement, "escape"));
      const { sandbox, bridge } = mountSandbox(
        workspaceDir,
        [
          `${replacement}:/workspace:rw`,
          `${data}:/data:rw`,
          ...(process.platform === "win32" ? [] : [`${data}:${workspaceDir}:rw`]),
        ],
        ["/workspace/cache"],
      );
      const { write, list } = installLocalTransport(bridge);
      const { execute, text, edit } = createSandboxCodingTools(sandbox, { workspaceOnly });
      for (const filePath of [
        "sub/marker",
        "/workspace/sub/marker",
        "file:///workspace/sub/marker",
      ]) {
        expect(await text("read", filePath)).toContain("VISIBLE");
      }
      for (const filePath of ["sub/marker", "/workspace/sub/marker"]) {
        await execute("write", { path: filePath, content: "changed" });
        await edit(filePath, "changed", "edited");
        await expectFile(replacement, "sub/marker", "edited");
      }
      await execute("write", { path: "@literal", content: "new-at" });
      await edit("@literal", "new-at", "edited-at");
      await expectFile(replacement, "@literal", "edited-at");
      expect(await text("read", "@@literal")).toContain("edited-at");
      await execute("write", { path: "@@literal", content: "reference original" });
      await edit("@@literal", "original", "edited");
      await expectFile(replacement, "@literal", "reference edited");
      await expectFile(replacement, "literal", "DECOY");
      const mentionedDirectory = await text("ls", "@@directory");
      expect(mentionedDirectory).toContain("literal-marker");
      expect(mentionedDirectory).not.toContain("decoy-marker");
      for (const filePath of ["sub", "/workspace/sub"]) {
        expect(await text("ls", filePath)).toContain("marker");
      }
      for (const args of [{}, { path: "" }, { path: "." }]) {
        expect(getTextContent(await execute("ls", args))).toContain("sub/");
      }
      const writesBeforeDenials = write.mock.calls.length;
      const listsBeforeDenials = list.mock.calls.length;
      await expect(execute("ls", { path: "</arg_value>>" })).rejects.toThrow(
        "Malformed path parameter: path",
      );
      for (const containerRoot of [
        "/data",
        ...(process.platform === "win32" ? [] : [workspaceDir]),
      ]) {
        expect(await text("read", `${containerRoot}/marker`)).toContain("EXTRA");
        if (workspaceOnly) {
          for (const attempt of [
            () => execute("write", { path: `${containerRoot}/marker`, content: "denied" }),
            () => edit(`${containerRoot}/marker`, "EXTRA", "denied"),
            () => execute("ls", { path: containerRoot }),
          ]) {
            await expect(attempt()).rejects.toThrow("Path escapes sandbox root");
          }
        }
      }
      for (const name of ["read", "write", "ls"]) {
        await expect(
          execute(name, { path: "/workspace/cache/marker", content: "denied" }),
        ).rejects.toThrow("container-only");
      }
      await expect(execute("read", { path: "escape/marker" })).rejects.toThrow();
      expect(write).toHaveBeenCalledTimes(writesBeforeDenials);
      expect(list).toHaveBeenCalledTimes(listsBeforeDenials);
      await expectFile(outside, "marker", "HIDDEN");
      await expectFile(data, "marker", "EXTRA");
    }),
);

it("prepares patch-only workspace admission and preserves the admitted container alias", () =>
  withTempDir("openclaw-patch-mounts-", async (root) => {
    const workspaceDir = path.join(root, "workspace");
    const replacement = path.join(root, "replacement");
    const nested = path.join(root, "nested");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspaceDir);
    await writeFiles(root, {
      "replacement/sub/marker": "VISIBLE\n",
      "replacement/@patch": "LITERAL\n",
      "replacement/patch": "DECOY\n",
      "nested/marker": "NESTED\n",
      "outside/marker": "HIDDEN\n",
    });
    await linkDirectory(outside, path.join(workspaceDir, "sub"));
    const { sandbox, bridge } = mountSandbox(workspaceDir, [
      `${replacement}:/workspace:rw`,
      `${nested}:/data:ro`,
      `${nested}:/workspace/nested:rw`,
      `${nested}:/workspace/alias:rw`,
      `${outside}:/extra:rw`,
    ]);
    installLocalTransport(bridge);
    const patchTool = (workspaceOnly: boolean) =>
      createSandboxCodingTools(sandbox, {
        includeBaseCodingTools: false,
        shellTools: "full",
        workspaceOnly: false,
        applyPatchEnabled: true,
        applyPatchWorkspaceOnly: workspaceOnly,
      }).patch;
    const patch = patchTool(true);
    for (const [filePath, before, after] of [
      ["sub/marker", "VISIBLE", "changed"],
      ["/workspace/sub/marker", "changed", "changed-again"],
      ["nested/marker", "NESTED", "changed"],
    ] as const) {
      await patch(updatePatch(filePath, before, after));
      expect(await bridge.readFile({ filePath })).toEqual(Buffer.from(`${after}\n`));
    }
    await patch(updatePatch("@@patch", "LITERAL", "referenced"));
    await expectFile(replacement, "@patch", "referenced\n");
    await expectFile(replacement, "patch", "DECOY\n");
    const move = (to: string, before: string, after: string) =>
      updatePatch("nested/marker", before, after, to);
    await patch(move("alias/marker", "changed", "moved"));
    await expectFile(nested, "marker", "moved\n");
    expect(getTextContent(await patch(move("alias/marker", "moved", "moved")))).toContain(
      "No changes made",
    );
    await fs.writeFile(path.join(nested, "occupied"), "KEEP\n");
    await expect(patch(move("alias/occupied", "moved", "lost"))).rejects.toThrow("already exists");
    await expectFile(nested, "marker", "moved\n");
    await expectFile(nested, "occupied", "KEEP\n");
    const add = (filePath: string) =>
      ["*** Begin Patch", `*** Add File: ${filePath}`, "+new", "*** End Patch"].join("\n");
    await patch(add("sub/new"));
    await expectFile(replacement, "sub/new", "new\n");
    for (const file of ["/data/new", "/extra/new"]) {
      await expect(patch(add(file))).rejects.toThrow("Path escapes sandbox root");
    }
    await patchTool(false)(add("/extra/new"));
    await expectFile(outside, "new", "new\n");
    if (process.platform !== "win32") {
      await fs.symlink(path.join(outside, "marker"), path.join(replacement, "delete-link"));
      mockContainerCanonicalPaths({ "/workspace/delete-link": "/outside/marker" });
      await patch("*** Begin Patch\n*** Delete File: delete-link\n*** End Patch");
      await expect(fs.lstat(path.join(replacement, "delete-link"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    const observer = createMemoryWriteProvenanceObserver({
      mutationRoot: workspaceDir,
      workspaceDir,
      resolvePath: (filePath) =>
        resolveSandboxFileIdentity({ bridge, filePath, cwd: workspaceDir }),
      resolveOriginClass: () => "agent",
    });
    expect(await observer.classifies("/workspace/memory/2026-09-14.md")).toBe(true);
    expect(await observer.classifies("/data/memory/2026-09-14.md")).toBe(false);
    await expectFile(outside, "marker", "HIDDEN\n");
  }));
