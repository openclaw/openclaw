import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createHostWorkspaceEditTool,
  createHostWorkspaceWriteTool,
  wrapToolMemoryFlushAppendOnlyWrite,
} from "./agent-tools.read.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

describe("workspace mutation authority", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    __setFsSafeTestHooksForTest();
    vi.restoreAllMocks();
  });

  it.each(
    (["write", "edit", "append"] as const).flatMap((kind) =>
      (["active", "revoked", "aborted"] as const).map((authority) => ({ kind, authority })),
    ),
  )("checks $authority authority inside $kind preparation", async ({ kind, authority }) => {
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
        authority === "revoked" ? "authority is no longer active" : "Workspace operation cancelled",
      );
    }
    expect(prepared).toBe(true);
    const changedContent = kind === "append" ? "original\nappended\n" : "replacement\n";
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(
      authority === "active" ? changedContent : "original\n",
    );
    await expect(fs.readdir(root)).resolves.toEqual(["memory.md"]);
  });

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

  it("creates a missing workspace and parent directories on the first write", async () => {
    const fixture = tempDirs.make("openclaw-missing-workspace-");
    const root = path.join(fixture, "workspace");
    const tool = createHostWorkspaceWriteTool(root, { workspaceOnly: true });

    await tool.execute("create-workspace", { path: "nested/file.txt", content: "new" });

    await expect(fs.readFile(path.join(root, "nested/file.txt"), "utf8")).resolves.toBe("new");
  });

  it("writes and edits inside a literal tilde directory within the workspace", async () => {
    const root = tempDirs.make("openclaw-workspace-tilde-");
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
