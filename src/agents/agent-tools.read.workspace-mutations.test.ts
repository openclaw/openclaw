import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createHostWorkspaceEditTool,
  createHostWorkspaceWriteTool,
  wrapToolMemoryFlushAppendOnlyWrite,
} from "./agent-tools.read.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("workspace mutation authority", () => {
  afterEach(() => {
    __setFsSafeTestHooksForTest();
    vi.restoreAllMocks();
  });

  it.each([
    { kind: "write", authority: "revoked" },
    { kind: "edit", authority: "aborted" },
    { kind: "append", authority: "active" },
    { kind: "append", authority: "revoked" },
    { kind: "append", authority: "aborted" },
  ] as const)(
    "checks $authority authority inside $kind preparation",
    async ({ kind, authority }) => {
      const root = tempDirs.make("openclaw-workspace-mutation-");
      const filePath = path.join(root, "memory.md");
      await fs.writeFile(filePath, "original\n");
      const generation = new AbortController();
      let current = true;
      let prepared = false;
      const finishPreparation = () => {
        prepared = true;
        if (authority === "revoked") {
          current = false;
        } else if (authority === "aborted") {
          generation.abort(new Error("Workspace operation cancelled"));
        }
      };
      if (kind === "append") {
        const realOpen = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await realOpen(...args);
          const [target, flags] = args;
          if (
            String(target) === filePath &&
            typeof flags === "number" &&
            (flags & constants.O_APPEND) !== 0
          ) {
            const read = handle.read.bind(handle);
            handle.read = (async (...readArgs: Parameters<typeof read>) => {
              const result = await read(...readArgs);
              finishPreparation();
              return result;
            }) as typeof handle.read;
          }
          return handle;
        });
      } else {
        const targetPath = await fs.realpath(filePath);
        __setFsSafeTestHooksForTest({
          // Native writes do not open their staging handles through node:fs.
          beforePinnedWriteParentAdmission: async (preparedPath) => {
            if (preparedPath === targetPath) {
              await Promise.resolve();
              finishPreparation();
            }
          },
        });
      }
      const options = { workspaceOnly: true, abortSignal: generation.signal };
      const execute = () => {
        if (kind === "append") {
          return wrapToolMemoryFlushAppendOnlyWrite(createHostWorkspaceWriteTool(root, options), {
            root,
            relativePath: "memory.md",
          }).execute(
            "workspace-append",
            { path: "memory.md", content: "appended\n" },
            generation.signal,
          );
        }
        if (kind === "edit") {
          return createHostWorkspaceEditTool(root, options).execute("workspace-edit", {
            path: "memory.md",
            edits: [{ oldText: "original", newText: "replacement" }],
          });
        }
        return createHostWorkspaceWriteTool(root, options).execute("workspace-write", {
          path: "memory.md",
          content: "replacement\n",
        });
      };

      const pending = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:workspace-mutations",
          receiptAuthority: () => current,
        },
        execute,
      );
      if (authority === "active") {
        await expect(pending).resolves.toBeDefined();
      } else {
        await expect(pending).rejects.toThrow(
          authority === "revoked"
            ? "authority is no longer active"
            : "Workspace operation cancelled",
        );
      }
      expect(prepared).toBe(true);
      const changedContent = kind === "append" ? "original\nappended\n" : "replacement\n";
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(
        authority === "active" ? changedContent : "original\n",
      );
      await expect(fs.readdir(root)).resolves.toEqual(["memory.md"]);
    },
  );

  it.each(["existing", "missing"] as const)(
    "rechecks authority before creating directories in a %s workspace",
    async (workspace) => {
      const fixture = tempDirs.make("openclaw-workspace-mkdir-authority-");
      const root = workspace === "existing" ? fixture : path.join(fixture, "workspace");
      const firstDirectory = workspace === "existing" ? path.join(root, "nested") : root;
      let current = true;
      let prepared = false;
      __setFsSafeTestHooksForTest({
        beforeRootFallbackMutation: async (operation, targetPath) => {
          if (operation === "mkdir" && targetPath === firstDirectory) {
            await Promise.resolve();
            current = false;
            prepared = true;
          }
        },
      });
      const tool = createHostWorkspaceWriteTool(root, { workspaceOnly: true });
      const pending = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:workspace-mkdir",
          receiptAuthority: () => current,
        },
        () => tool.execute("workspace-mkdir", { path: "nested/file.txt", content: "new" }),
      );

      await expect(pending).rejects.toThrow("authority is no longer active");
      expect(prepared).toBe(true);
      await expect(fs.access(firstDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("creates a missing workspace and writes and edits inside its literal tilde directory", async () => {
    const fixture = tempDirs.make("openclaw-workspace-tilde-");
    const root = path.join(fixture, "workspace");
    const filePath = path.join(root, "~", "file.txt");
    const options = { workspaceOnly: true };

    await createHostWorkspaceWriteTool(root, options).execute("literal-tilde-write", {
      path: filePath,
      content: "original",
    });
    await createHostWorkspaceEditTool(root, options).execute("literal-tilde-edit", {
      path: filePath,
      edits: [{ oldText: "original", newText: "replacement" }],
    });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("replacement");
  });

  it.runIf(process.platform !== "win32")(
    "writes through a directory symlink whose target is the workspace root",
    async () => {
      const root = tempDirs.make("openclaw-workspace-root-link-");
      const alias = path.join(root, "self");
      await fs.symlink(root, alias, "dir");
      const tool = createHostWorkspaceWriteTool(root, { workspaceOnly: true });

      await tool.execute("workspace-root-link", { path: "self/file.txt", content: "new" });

      await expect(fs.readFile(path.join(root, "file.txt"), "utf8")).resolves.toBe("new");
      expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
    },
  );
});

describe("host file paths", () => {
  it("writes and edits the same OS-home path despite OPENCLAW_HOME", async () => {
    const home = process.env.HOME ?? os.homedir();
    const directory = tempDirs.make("openclaw-host-home-", home);
    const openclawHome = tempDirs.make("openclaw-home-override-");
    const filePath = path.join(directory, "nested", "file.txt");
    const modelPath = path.join("~", path.relative(home, filePath));

    await withEnvAsync({ OPENCLAW_HOME: openclawHome }, async () => {
      await createHostWorkspaceWriteTool(openclawHome).execute("write", {
        path: modelPath,
        content: "original",
      });
      await createHostWorkspaceEditTool(openclawHome).execute("edit", {
        path: modelPath,
        edits: [{ oldText: "original", newText: "replacement" }],
      });
      expect(await fs.readFile(filePath, "utf8")).toBe("replacement");
      expect(await fs.readdir(openclawHome)).toEqual([]);
    });
  });

  it.runIf(process.platform !== "win32")("reports the workspace escape through edit", async () => {
    const fixture = tempDirs.make("openclaw-edit-escape-");
    const root = path.join(fixture, "workspace");
    const outside = path.join(fixture, "outside");
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.symlink(outside, path.join(root, "escape"));

    await expect(
      createHostWorkspaceEditTool(root, { workspaceOnly: true }).execute("escape", {
        path: "escape/secret.txt",
        edits: [{ oldText: "secret", newText: "changed" }],
      }),
    ).rejects.toThrow("Path escapes workspace root");
    expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
  });
});
