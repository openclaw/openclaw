import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import * as logger from "../logger.js";
import { withTempDir } from "../test-utils/temp-dir.js";
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
function tool(name: string, options: Parameters<typeof createOpenClawCodingTools>[0]) {
  return expectDefined(
    createOpenClawCodingTools(options).find((entry) => entry.name === name),
    name,
  );
}
async function workspace(
  run: (paths: { parent: string; root: string; outside: string }) => Promise<void>,
) {
  await withTempDir("openclaw-permissions-", async (dir) => {
    const parent = await fs.realpath(dir);
    const root = path.join(parent, "workspace");
    const outside = path.join(parent, "outside.txt");
    await fs.mkdir(path.join(root, "packages/app"), { recursive: true });
    await fs.writeFile(outside, "original\n");
    await run({ parent, root, outside });
  });
}
async function aliasedWorkspace(
  run: (paths: { parent: string; root: string; alias: string; outside: string }) => Promise<void>,
) {
  await workspace(async (paths) => {
    const alias = path.join(paths.parent, "workspace-alias");
    await fs.symlink(paths.root, alias, "dir");
    await expect(fs.realpath(alias)).resolves.toBe(paths.root);
    await run({ ...paths, alias });
  });
}

describe("session permission filesystem tools", () => {
  it("logs required-root containment without exposing policy advice in full mode", async () => {
    await workspace(async ({ root, outside }) => {
      const patch = tool("apply_patch", {
        workspaceDir: root,
        requireWorkspaceOnly: true,
        sessionPermissionPolicy: { root, mode: "full" },
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
          error: `Path escapes sandbox root (${root}): ${outside}`,
        });
        await expect(fs.readFile(outside, "utf8")).resolves.toBe("original\n");
      } finally {
        logError.mockRestore();
      }
    });
  });

  describe.runIf(process.platform !== "win32")("trusted workspace aliases", () => {
    it.each(fileTools)("allows %s within the canonical root", async (name) => {
      await aliasedWorkspace(async ({ root, alias }) => {
        const target = path.join(root, "proof.txt");
        await fs.writeFile(target, "original\n");
        const operation = tool(name, {
          workspaceDir: alias,
          cwd: path.join(alias, "packages/app"),
          sessionPermissionPolicy: { root, mode: "guarded" },
        });
        const result = await operation.execute(
          "alias",
          args(name, name === "read" ? path.join(alias, "proof.txt") : "../../proof.txt"),
        );
        if (name === "read") {
          expect(getTextContent(result)).toBe("original\n");
        }
        await expect(fs.readFile(target, "utf8")).resolves.toBe(
          name === "read" ? "original\n" : "changed\n",
        );
      });
    });

    it("allows read-only alias reads while excluding mutations and outside files", async () => {
      await aliasedWorkspace(async ({ root, alias, outside }) => {
        await fs.writeFile(path.join(root, "proof.txt"), "original\n");
        const tools = createOpenClawCodingTools({
          workspaceDir: alias,
          cwd: alias,
          sessionPermissionPolicy: { root, mode: "read-only" },
        });
        const names = tools.map((entry) => entry.name);
        expect(names).toContain("exec");
        for (const name of ["write", "edit", "apply_patch"]) {
          expect(names).not.toContain(name);
        }
        const read = expectDefined(
          tools.find((entry) => entry.name === "read"),
          "read",
        );
        expect(getTextContent(await read.execute("inside", { path: "proof.txt" }))).toBe(
          "original\n",
        );
        await expect(read.execute("outside", { path: outside })).rejects.toThrow(/sandbox root/i);
      });
    });

    it("denies unrelated external aliases pointing into the root", async () => {
      await aliasedWorkspace(async ({ parent, root, alias }) => {
        const inside = path.join(root, "proof.txt");
        await fs.writeFile(inside, "original\n");
        const tools = createOpenClawCodingTools({
          workspaceDir: alias,
          cwd: alias,
          sessionPermissionPolicy: { root, mode: "guarded" },
        });
        for (const untrusted of [path.join(parent, "external-alias"), `${alias}-untrusted`]) {
          await fs.symlink(root, untrusted, "dir");
          const target = path.join(untrusted, "proof.txt");
          await expect(fs.realpath(target)).resolves.toBe(inside);
          for (const name of fileTools) {
            const operation = expectDefined(
              tools.find((entry) => entry.name === name),
              name,
            );
            await expect(operation.execute("inward", args(name, target))).rejects.toThrow(
              /escapes sandbox root/i,
            );
            await expect(fs.readFile(inside, "utf8")).resolves.toBe("original\n");
          }
        }
      });
    });

    it("keeps missing daily memory optional through the alias", async () => {
      await aliasedWorkspace(async ({ root, alias }) => {
        const read = tool("read", {
          workspaceDir: alias,
          sessionPermissionPolicy: { root, mode: "guarded" },
        });
        expect(
          (await read.execute("memory", { path: "memory/2026-08-27.md" })).details,
        ).toMatchObject({ kind: "not_found", optional: true });
      });
    });

    it("retains patch creation parent checks through trusted aliases", async () => {
      await aliasedWorkspace(async ({ root, alias }) => {
        await fs.mkdir(path.join(root, "real"));
        await fs.symlink(path.join(root, "real"), path.join(root, "link"), "dir");
        const patch = tool("apply_patch", {
          workspaceDir: alias,
          cwd: alias,
          sessionPermissionPolicy: { root, mode: "guarded" },
        });
        for (const target of [path.join(root, "link/new.txt"), path.join(alias, "link/new.txt")]) {
          await expect(
            patch.execute("parent", {
              input: `*** Begin Patch\n*** Add File: ${target}\n+created\n*** End Patch`,
            }),
          ).rejects.toMatchObject({ name: "FsSafeError", code: "symlink" });
        }
        await expect(fs.readdir(path.join(root, "real"))).resolves.toEqual([]);
        await patch.execute("create", {
          input: `*** Begin Patch\n*** Add File: ${alias}/new/proof.txt\n+created\n*** End Patch`,
        });
        await expect(fs.readFile(path.join(root, "new/proof.txt"), "utf8")).resolves.toBe(
          "created\n",
        );
      });
    });

    it.each(["../outside/proof.txt", "escape.txt", "sub/up/../outside/proof.txt"])(
      "denies escape %s without changing either target",
      async (relativeEscape) => {
        await aliasedWorkspace(async ({ parent, root, alias }) => {
          const outside = path.join(parent, "outside/proof.txt");
          const decoy = path.join(root, "sub/outside/proof.txt");
          for (const target of [outside, decoy]) {
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, "original\n");
          }
          await fs.symlink(outside, path.join(root, "escape.txt"));
          await fs.symlink("..", path.join(root, "sub/up"), "dir");
          // Preserve raw '..' bytes: native traversal escapes while normalization hits the decoy.
          const canonicalInput = `${root}/${relativeEscape}`;
          await expect(fs.realpath(canonicalInput)).resolves.toBe(outside);
          const tools = createOpenClawCodingTools({
            workspaceDir: alias,
            cwd: alias,
            sessionPermissionPolicy: { root, mode: "guarded" },
          });
          for (const name of fileTools) {
            const operation = expectDefined(
              tools.find((entry) => entry.name === name),
              name,
            );
            for (const input of [canonicalInput, relativeEscape]) {
              await expect(operation.execute("escape", args(name, input))).rejects.toThrow(
                /(?:escapes|outside) sandbox root/i,
              );
              await expect(fs.readFile(outside, "utf8")).resolves.toBe("original\n");
              await expect(fs.readFile(decoy, "utf8")).resolves.toBe("original\n");
            }
          }
          await expect(fs.readlink(path.join(root, "escape.txt"))).resolves.toBe(outside);
        });
      },
    );
  });

  it("separates a nested session cwd from its workspace permission boundary", async () => {
    await workspace(async ({ root, outside }) => {
      const tools = createOpenClawCodingTools({
        workspaceDir: root,
        cwd: path.join(root, "packages/app"),
        sessionPermissionPolicy: { root, mode: "workspace" },
      });
      const read = expectDefined(
        tools.find((entry) => entry.name === "read"),
        "read",
      );
      const write = expectDefined(
        tools.find((entry) => entry.name === "write"),
        "write",
      );
      const patch = expectDefined(
        tools.find((entry) => entry.name === "apply_patch"),
        "patch",
      );
      await fs.writeFile(path.join(root, "shared.txt"), "original\n");
      expect(getTextContent(await read.execute("nested", { path: "../../shared.txt" }))).toBe(
        "original\n",
      );
      await write.execute("nested", { path: "../../created.txt", content: "created" });
      await expect(fs.readFile(path.join(root, "created.txt"), "utf8")).resolves.toBe("created");
      await patch.execute("nested", args("apply_patch", "../../shared.txt"));
      await expect(fs.readFile(path.join(root, "shared.txt"), "utf8")).resolves.toBe("changed\n");
      await expect(read.execute("outside", { path: outside })).rejects.toThrow(/sandbox root/i);
    });
  });

  it("denies exec when a turn tightens the dispatch-provided full mode", async () => {
    await workspace(async ({ root }) => {
      const exec = tool("exec", {
        workspaceDir: root,
        sessionPermissionPolicy: { root, mode: "full" },
        exec: { host: "gateway", mode: "full", security: "deny", ask: "off" },
      });
      await expect(
        exec.execute("tightened", { command: "echo exec-policy-proof" }),
      ).rejects.toThrow(/security=deny/);
    });
  });

  it.each([undefined, true] as const)(
    "confines full-mode directory listing when required=%s",
    async (required) => {
      await workspace(async ({ root, parent }) => {
        const ls = tool("ls", {
          workspaceDir: root,
          requireWorkspaceOnly: required,
          sessionPermissionPolicy: { root, mode: "full" },
        });
        expect(getTextContent(await ls.execute("inside", { path: "." }))).toBe('"packages/"');
        if (required) {
          await expect(ls.execute("outside", { path: parent })).rejects.toThrow(/sandbox root/i);
        } else {
          expect(getTextContent(await ls.execute("outside", { path: parent }))).toContain(
            "outside.txt",
          );
        }
      });
    },
  );

  it.each([
    { name: "write", required: true },
    { name: "write", required: undefined },
    { name: "apply_patch", required: undefined },
  ] as const)(
    "preserves full-mode $name authority with required root=$required",
    async ({ name, required }) => {
      await workspace(async ({ root, outside }) => {
        const inside = path.join(root, "proof.txt");
        await fs.writeFile(inside, "original\n");
        const operation = tool(name, {
          workspaceDir: root,
          requireWorkspaceOnly: required,
          sessionPermissionPolicy: { root, mode: "full" },
        });
        await operation.execute("inside", args(name, inside));
        await expect(fs.readFile(inside, "utf8")).resolves.toBe("changed\n");
        if (required) {
          await expect(operation.execute("outside", args(name, outside))).rejects.toThrow(
            /sandbox root/i,
          );
          await expect(fs.readFile(outside, "utf8")).resolves.toBe("original\n");
        } else {
          await operation.execute("outside", args(name, outside));
          await expect(fs.readFile(outside, "utf8")).resolves.toBe("changed\n");
        }
      });
    },
  );
});
