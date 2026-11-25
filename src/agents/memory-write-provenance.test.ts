import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { readMemoryArtifactProvenance } from "../memory/memory-artifact-provenance.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  createMemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "./memory-write-provenance.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

afterEach(() => resetPluginStateStoreForTests());

function wrappedReadFailure(code: string, message: string) {
  const writeFile = vi.fn(async (_absolutePath: string, _content: string) => {});
  const write = vi.fn(async ({ commit }: { commit: () => Promise<void> }) => commit());
  const operations = withMemoryWriteProvenance(
    {
      readFile: async () => {
        throw new Error(message, { cause: Object.assign(new Error(code), { code }) });
      },
      writeFile,
    },
    { classifies: async () => true, write, clearAfterDelete: async () => {} },
  );
  const run = (target: string, content: string) =>
    withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:memory-read-cause" },
      () => operations.writeFile(target, content),
    );
  return { writeFile, write, run };
}

it.each(["write", "remove"] as const)(
  "commits a %s through its provenance observer",
  async (operation) => {
    await withStateDirEnv("openclaw-memory-provenance-", async ({ tempRoot }) => {
      const target = `${tempRoot}/MEMORY.md`;
      await fs.writeFile(target, "before");
      const operations = withMemoryWriteProvenance(
        {
          readFile: (file, signal?: AbortSignal) => fs.readFile(file, { signal }),
          writeFile: (file, content, signal?: AbortSignal) =>
            fs.writeFile(file, content, { signal }),
          remove: fs.rm,
        },
        {
          classifies: async () => true,
          write: async ({ commit }) => commit(),
          clearAfterDelete: async () => {},
        },
      );
      if (operation === "remove") {
        await operations.remove(target);
        await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await operations.writeFile(target, "after");
        expect(await fs.readFile(target, "utf8")).toBe("after");
      }
    });
  },
);

it("rolls provenance back when the filesystem write fails", async () => {
  await withStateDirEnv("openclaw-memory-provenance-", async ({ tempRoot }) => {
    const observer = createMemoryWriteProvenanceObserver({
      mutationRoot: tempRoot,
      workspaceDir: tempRoot,
      resolveOriginClass: () => "untrusted",
      now: () => 1,
    });
    const commit = vi.fn(async () => {
      throw new Error("disk full");
    });

    await expect(
      observer.write({
        absolutePath: `${tempRoot}/MEMORY.md`,
        contentBefore: "before",
        contentAfter: "after",
        commit,
      }),
    ).rejects.toThrow("disk full");
    await expect(
      readMemoryArtifactProvenance({ workspaceDir: tempRoot, relativePath: "MEMORY.md" }),
    ).resolves.toBeUndefined();
    expect(commit).toHaveBeenCalledOnce();
  });
});

it("treats a wrapped missing-path read as empty prior content", async () => {
  const { writeFile, write, run } = wrappedReadFailure("not-found", "sandbox bridge read failed");
  await run("/workspace/memory/new.md", "new memory file");
  expect(write).toHaveBeenCalledWith(expect.objectContaining({ contentBefore: "" }));
  expect(writeFile).toHaveBeenCalledOnce();
});

it("does not treat a wrapped boundary read error as a missing path", async () => {
  const message = "sandbox boundary checks failed";
  const { writeFile, write, run } = wrappedReadFailure("EACCES", message);
  await expect(run("/outside/new.md", "must not write")).rejects.toThrow(message);
  expect(write).not.toHaveBeenCalled();
  expect(writeFile).not.toHaveBeenCalled();
});
