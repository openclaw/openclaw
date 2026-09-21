import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
  // Keep real path guards and pinned reads; injected transport persists bytes
  // so the session tools still enforce their ordinary readback verification.
  const write = vi
    .spyOn(bridge, "writeFile")
    .mockImplementation((params) => local.writeFile(params));
  const create = vi
    .spyOn(bridge, "createFileExclusive")
    .mockImplementation((params) => local.createFileExclusive!(params));
  const remove = vi.spyOn(bridge, "remove").mockImplementation((params) => local.remove(params));
  vi.spyOn(bridge, "mkdirp").mockImplementation((params) => local.mkdirp(params));
  vi.spyOn(bridge, "stat").mockImplementation((params) => local.stat(params));
  const list = vi.spyOn(bridge, "readDirectory").mockImplementation(async (params) =>
    (await fs.readdir(bridge.resolvePath(params).hostPath!, { withFileTypes: true })).map(
      (entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }),
    ),
  );
  return { write, create, remove, list };
}

describe("workspace-only coding tools with effective sandbox mounts", () => {
  installFsBridgeTestHarness();

  it.runIf(process.platform !== "win32").each([true, false])(
    "keeps literal backslash read/write/edit/patch targets distinct with workspaceOnly=%s",
    async (workspaceOnly) => {
      await withTempDir("openclaw-coding-mounts-", async (workspaceDir) => {
        await fs.mkdir(path.join(workspaceDir, "a"));
        await fs.writeFile(path.join(workspaceDir, "a\\b"), "LITERAL_ORIGINAL\n");
        await fs.writeFile(path.join(workspaceDir, "a/b"), "SLASH_DECOY\n");
        const sandbox = createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          workspaceAccess: "rw",
        });
        const bridge = createSandboxFsBridge({ sandbox });
        sandbox.fsBridge = bridge;
        installLocalTransport(bridge);
        const tools = createCoreCodingTools({
          codingRoot: workspaceDir,
          containmentRoot: workspaceDir,
          includeBaseCodingTools: true,
          shellTools: "full",
          workspaceOnly,
          readOnly: false,
          sandbox,
          applyPatchEnabled: true,
          applyPatchWorkspaceOnly: workspaceOnly,
          execDefaults: {},
          processDefaults: {},
        });
        const tool = (name: string) => tools.find((entry) => entry.name === name)!;
        for (const filePath of ["a\\b", "/workspace/a\\b"]) {
          const text = getTextContent(
            await tool("read").execute("read-literal", { path: filePath }),
          );
          expect(text).toContain("LITERAL_ORIGINAL");
          expect(text).not.toContain("SLASH_DECOY");
        }
        await tool("write").execute("write-literal", {
          path: "a\\b",
          content: "LITERAL_WRITTEN\n",
        });
        await tool("edit").execute("edit-literal", {
          path: "a\\b",
          edits: [{ oldText: "LITERAL_WRITTEN", newText: "LITERAL_EDITED" }],
        });
        await tool("apply_patch").execute("patch-literal", {
          input:
            "*** Begin Patch\n*** Update File: a\\b\n@@\n-LITERAL_EDITED\n+LITERAL_PATCHED\n*** End Patch",
        });
        expect(await fs.readFile(path.join(workspaceDir, "a\\b"), "utf8")).toBe(
          "LITERAL_PATCHED\n",
        );
        expect(await fs.readFile(path.join(workspaceDir, "a/b"), "utf8")).toBe("SLASH_DECOY\n");
        expect(await resolveSandboxFileIdentity({ bridge, filePath: "a\\b" })).not.toBe(
          await resolveSandboxFileIdentity({ bridge, filePath: "a/b" }),
        );
      });
    },
  );

  it.runIf(process.platform !== "win32").each([true, false])(
    "reads mapped aliases through real access and queue checks with workspaceOnly=%s",
    async (workspaceOnly) => {
      await withTempDir("openclaw-coding-mounts-", async (root) => {
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
        const sandbox = createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          workspaceAccess: "rw",
          docker: {
            ...createSandbox().docker,
            binds: [`${replacement}:/workspace/cache:rw`, `${replacement}:/data:rw`],
          },
        });
        const bridge = createSandboxFsBridge({ sandbox });
        sandbox.fsBridge = bridge;
        mockContainerCanonicalPaths({
          "/workspace/alias": "/workspace/cache/hop",
          "/workspace/absolute-alias": "/data/hop",
        });
        const tools = createCoreCodingTools({
          codingRoot: workspaceDir,
          containmentRoot: workspaceDir,
          includeBaseCodingTools: true,
          shellTools: "disabled",
          workspaceOnly,
          readOnly: false,
          sandbox,
          applyPatchEnabled: false,
          applyPatchWorkspaceOnly: true,
          execDefaults: {},
          processDefaults: {},
        });
        const read = tools.find((tool) => tool.name === "read")!;
        for (const filePath of ["alias", "absolute-alias", "/data/hop"]) {
          const text = getTextContent(await read.execute("read-alias", { path: filePath }));
          expect(text).toContain(visibleContent);
          expect(text).not.toContain(hiddenContent);
          expect(await resolveSandboxFileIdentity({ bridge, filePath })).toBe(
            path.join(replacement, "hop"),
          );
        }
        if (workspaceOnly) {
          for (const name of ["write", "edit", "ls"]) {
            await expect(
              tools
                .find((tool) => tool.name === name)!
                .execute("deny-extra", {
                  path: "/data/hop",
                  content: "changed",
                  oldText: visibleContent,
                  newText: "changed",
                }),
            ).rejects.toThrow("Path escapes sandbox root");
          }
        }
        expect(await fs.readFile(path.join(workspaceDir, "visible.txt"), "utf8")).toBe(
          hiddenContent,
        );
        expect(await fs.readFile(path.join(replacement, "hop"), "utf8")).toBe(visibleContent);
      });
    },
  );

  it.each([true, false])(
    "preserves container execution paths with workspaceOnly=%s",
    async (workspaceOnly) => {
      await withTempDir("openclaw-coding-mounts-", async (root) => {
        const workspaceDir = path.join(root, "workspace");
        const replacement = path.join(root, "replacement");
        const outside = path.join(root, "outside");
        const data = path.join(root, "data");
        for (const dir of [workspaceDir, replacement, outside, data]) {
          await fs.mkdir(dir);
        }
        await fs.mkdir(path.join(replacement, "sub"));
        await fs.mkdir(path.join(replacement, "cache"));
        await fs.writeFile(path.join(replacement, "sub/marker"), "VISIBLE");
        await fs.writeFile(path.join(replacement, "@literal"), "AT");
        await fs.writeFile(path.join(replacement, "literal"), "DECOY");
        await fs.mkdir(path.join(replacement, "@directory"));
        await fs.mkdir(path.join(replacement, "directory"));
        await fs.writeFile(path.join(replacement, "@directory/literal-marker"), "AT");
        await fs.writeFile(path.join(replacement, "directory/decoy-marker"), "DECOY");
        await fs.writeFile(path.join(outside, "marker"), "HIDDEN");
        await fs.writeFile(path.join(data, "marker"), "EXTRA");
        await fs.symlink(
          outside,
          path.join(workspaceDir, "sub"),
          process.platform === "win32" ? "junction" : "dir",
        );
        await fs.symlink(
          outside,
          path.join(replacement, "escape"),
          process.platform === "win32" ? "junction" : "dir",
        );
        const sandbox = createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          workspaceAccess: "rw",
          docker: {
            ...createSandbox().docker,
            binds: [
              `${replacement}:/workspace:rw`,
              `${data}:/data:rw`,
              ...(process.platform === "win32" ? [] : [`${data}:${workspaceDir}:rw`]),
            ],
            tmpfs: ["/workspace/cache"],
          },
        });
        const bridge = createSandboxFsBridge({ sandbox });
        sandbox.fsBridge = bridge;
        const { write, list } = installLocalTransport(bridge);
        const tools = createCoreCodingTools({
          codingRoot: workspaceDir,
          containmentRoot: workspaceDir,
          includeBaseCodingTools: true,
          shellTools: "disabled",
          workspaceOnly,
          readOnly: false,
          sandbox,
          applyPatchEnabled: false,
          applyPatchWorkspaceOnly: true,
          execDefaults: {},
          processDefaults: {},
        });
        const tool = (name: string) => {
          const found = tools.find((entry) => entry.name === name);
          if (!found) {
            throw new Error(`Missing ${name} tool`);
          }
          return found;
        };
        for (const filePath of [
          "sub/marker",
          "/workspace/sub/marker",
          "file:///workspace/sub/marker",
        ]) {
          expect(
            getTextContent(await tool("read").execute("read-visible", { path: filePath })),
          ).toContain("VISIBLE");
        }
        for (const filePath of ["sub/marker", "/workspace/sub/marker"]) {
          await tool("write").execute("write-visible", { path: filePath, content: "changed" });
          await tool("edit").execute("edit-visible", {
            path: filePath,
            edits: [{ oldText: "changed", newText: "edited" }],
          });
          expect(await fs.readFile(path.join(replacement, "sub/marker"), "utf8")).toBe("edited");
        }
        expect(write).toHaveBeenCalledTimes(4);
        for (const [request] of write.mock.calls) {
          expect(request.filePath).toBe("/workspace/sub/marker");
          expect(bridge.resolvePath(request).hostPath).toBe(path.join(replacement, "sub/marker"));
        }
        await tool("write").execute("write-at", { path: "@literal", content: "new-at" });
        await tool("edit").execute("edit-at", {
          path: "@literal",
          edits: [{ oldText: "new-at", newText: "edited-at" }],
        });
        expect(await fs.readFile(path.join(replacement, "@literal"), "utf8")).toBe("edited-at");
        expect(write).toHaveBeenLastCalledWith(
          expect.objectContaining({ filePath: "/workspace/@literal" }),
        );
        expect(
          getTextContent(
            await tool("read").execute("read-reference-literal", { path: "@@literal" }),
          ),
        ).toContain("edited-at");
        await tool("write").execute("write-reference-literal", {
          path: "@@literal",
          content: "reference original",
        });
        await tool("edit").execute("edit-reference-literal", {
          path: "@@literal",
          edits: [{ oldText: "original", newText: "edited" }],
        });
        expect(await fs.readFile(path.join(replacement, "@literal"), "utf8")).toBe(
          "reference edited",
        );
        expect(await fs.readFile(path.join(replacement, "literal"), "utf8")).toBe("DECOY");
        const mentionedDirectory = getTextContent(
          await tool("ls").execute("list-reference-literal", { path: "@@directory" }),
        );
        expect(mentionedDirectory).toContain("literal-marker");
        expect(mentionedDirectory).not.toContain("decoy-marker");
        for (const filePath of ["sub", "/workspace/sub"]) {
          expect(
            getTextContent(await tool("ls").execute("list-visible", { path: filePath })),
          ).toContain("marker");
        }
        for (const args of [{}, { path: "" }, { path: "." }]) {
          expect(getTextContent(await tool("ls").execute("list-default", args))).toContain("sub/");
          expect(list).toHaveBeenLastCalledWith(
            expect.objectContaining({ filePath: "/workspace" }),
          );
        }
        expect(list).toHaveBeenCalledTimes(6);
        await expect(
          tool("ls").execute("list-malformed", { path: "</arg_value>>" }),
        ).rejects.toThrow("Malformed path parameter: path");
        expect(list).toHaveBeenCalledTimes(6);
        for (const containerRoot of [
          "/data",
          ...(process.platform === "win32" ? [] : [workspaceDir]),
        ]) {
          expect(
            getTextContent(
              await tool("read").execute("read-extra", { path: `${containerRoot}/marker` }),
            ),
          ).toContain("EXTRA");
          if (workspaceOnly) {
            for (const [name, args] of [
              ["write", { path: `${containerRoot}/marker`, content: "denied" }],
              [
                "edit",
                {
                  path: `${containerRoot}/marker`,
                  edits: [{ oldText: "EXTRA", newText: "denied" }],
                },
              ],
              ["ls", { path: containerRoot }],
            ] as const) {
              await expect(tool(name).execute("outside-workspace", args)).rejects.toThrow(
                "Path escapes sandbox root",
              );
            }
          }
        }
        for (const name of ["read", "write", "ls"]) {
          await expect(
            tool(name).execute("masked", { path: "/workspace/cache/marker", content: "denied" }),
          ).rejects.toThrow("container-only");
        }
        await expect(
          tool("read").execute("visible-escape", { path: "escape/marker" }),
        ).rejects.toThrow();
        expect(write).toHaveBeenCalledTimes(8);
        expect(list).toHaveBeenCalledTimes(6);
        expect(await fs.readFile(path.join(outside, "marker"), "utf8")).toBe("HIDDEN");
        expect(await fs.readFile(path.join(data, "marker"), "utf8")).toBe("EXTRA");
      });
    },
  );

  it("prepares patch-only workspace admission and preserves the admitted container alias", async () => {
    await withTempDir("openclaw-patch-mounts-", async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const replacement = path.join(root, "replacement");
      const nested = path.join(root, "nested");
      const outside = path.join(root, "outside");
      for (const dir of [workspaceDir, replacement, nested, outside]) {
        await fs.mkdir(dir);
      }
      await fs.mkdir(path.join(replacement, "sub"));
      await fs.writeFile(path.join(replacement, "sub/marker"), "VISIBLE\n");
      await fs.writeFile(path.join(replacement, "@patch"), "LITERAL\n");
      await fs.writeFile(path.join(replacement, "patch"), "DECOY\n");
      await fs.writeFile(path.join(nested, "marker"), "NESTED\n");
      await fs.writeFile(path.join(outside, "marker"), "HIDDEN\n");
      await fs.symlink(
        outside,
        path.join(workspaceDir, "sub"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const sandbox = createSandbox({
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
        docker: {
          ...createSandbox().docker,
          binds: [
            `${replacement}:/workspace:rw`,
            `${nested}:/data:ro`,
            `${nested}:/workspace/nested:rw`,
            `${nested}:/workspace/alias:rw`,
            `${outside}:/extra:rw`,
          ],
        },
      });
      const bridge = createSandboxFsBridge({ sandbox });
      sandbox.fsBridge = bridge;
      const { write, create, remove } = installLocalTransport(bridge);
      const patchTool = (workspaceOnly: boolean) => {
        const tool = createCoreCodingTools({
          codingRoot: workspaceDir,
          containmentRoot: workspaceDir,
          includeBaseCodingTools: false,
          shellTools: "full",
          workspaceOnly: false,
          readOnly: false,
          sandbox,
          applyPatchEnabled: true,
          applyPatchWorkspaceOnly: workspaceOnly,
          execDefaults: {},
          processDefaults: {},
        }).find((entry) => entry.name === "apply_patch");
        if (!tool) {
          throw new Error("Missing apply_patch tool");
        }
        return tool;
      };
      const patch = patchTool(true);
      for (const [filePath, before, after] of [
        ["sub/marker", "VISIBLE", "changed"],
        ["/workspace/sub/marker", "changed", "changed-again"],
        ["nested/marker", "NESTED", "changed"],
      ] as const) {
        await patch.execute("patch-visible", {
          input: [
            "*** Begin Patch",
            `*** Update File: ${filePath}`,
            "@@",
            `-${before}`,
            `+${after}`,
            "*** End Patch",
          ].join("\n"),
        });
        expect(await bridge.readFile({ filePath })).toEqual(Buffer.from(`${after}\n`));
      }
      expect(write.mock.calls.map(([request]) => request.filePath)).toEqual([
        "/workspace/sub/marker",
        "/workspace/sub/marker",
        "/workspace/nested/marker",
      ]);
      await patch.execute("patch-reference-literal", {
        input: [
          "*** Begin Patch",
          "*** Update File: @@patch",
          "@@",
          "-LITERAL",
          "+referenced",
          "*** End Patch",
        ].join("\n"),
      });
      expect(await fs.readFile(path.join(replacement, "@patch"), "utf8")).toBe("referenced\n");
      expect(await fs.readFile(path.join(replacement, "patch"), "utf8")).toBe("DECOY\n");
      const move = (to: string, before: string, after: string) =>
        [
          "*** Begin Patch",
          "*** Update File: nested/marker",
          `*** Move to: ${to}`,
          "@@",
          `-${before}`,
          `+${after}`,
          "*** End Patch",
        ].join("\n");
      await patch.execute("patch-same-file-move", {
        input: move("alias/marker", "changed", "moved"),
      });
      expect(await fs.readFile(path.join(nested, "marker"), "utf8")).toBe("moved\n");
      expect(
        getTextContent(
          await patch.execute("patch-same-file-noop", {
            input: move("alias/marker", "moved", "moved"),
          }),
        ),
      ).toContain("No changes made");
      await fs.writeFile(path.join(nested, "occupied"), "KEEP\n");
      await expect(
        patch.execute("patch-occupied-move", {
          input: move("alias/occupied", "moved", "lost"),
        }),
      ).rejects.toThrow("already exists");
      expect(await fs.readFile(path.join(nested, "marker"), "utf8")).toBe("moved\n");
      expect(await fs.readFile(path.join(nested, "occupied"), "utf8")).toBe("KEEP\n");
      const add = (filePath: string) =>
        ["*** Begin Patch", `*** Add File: ${filePath}`, "+new", "*** End Patch"].join("\n");
      await patch.execute("patch-add", { input: add("sub/new") });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: "/workspace/sub/new" }),
      );
      await expect(patch.execute("patch-outside", { input: add("/data/new") })).rejects.toThrow(
        "Path escapes sandbox root",
      );
      await expect(patch.execute("patch-outside", { input: add("/extra/new") })).rejects.toThrow(
        "Path escapes sandbox root",
      );
      await patchTool(false).execute("patch-opt-out", { input: add("/extra/new") });
      expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: "/extra/new" }));
      if (process.platform !== "win32") {
        await fs.symlink(path.join(outside, "marker"), path.join(replacement, "delete-link"));
        mockContainerCanonicalPaths({ "/workspace/delete-link": "/outside/marker" });
        await patch.execute("patch-unlink", {
          input: "*** Begin Patch\n*** Delete File: delete-link\n*** End Patch",
        });
        expect(remove).toHaveBeenCalledWith(
          expect.objectContaining({ filePath: "/workspace/delete-link" }),
        );
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
      expect(await fs.readFile(path.join(outside, "marker"), "utf8")).toBe("HIDDEN\n");
    });
  });
});
