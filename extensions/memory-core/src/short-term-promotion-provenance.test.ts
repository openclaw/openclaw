import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  createWorkspaceMemoryFileClient,
  registerAgentWorkspaceAccess,
} from "openclaw/plugin-sdk/agent-workspace-runtime";
import { commitMemoryContent } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { afterEach, expect, it, vi } from "vitest";
import { resolveBootstrapContextForRun } from "../../../src/agents/bootstrap-files.js";
import {
  createMemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "../../../src/agents/memory-write-provenance.js";
import { readMemoryArtifactProvenance } from "../../../src/memory/memory-artifact-provenance.js";
import * as pluginState from "../../../src/plugin-state/plugin-state-store.js";
import { resetPluginStateStoreForTests } from "../../../src/plugin-state/plugin-state-store.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "../../../src/plugins/memory-state.js";
import { withStateDirEnv } from "../../../src/test-helpers/state-dir-env.js";
import { serveMemoryFiles } from "./remote/memory-files-worker.js";
import { createMemoryRuntime } from "./runtime-provider.js";
import { applyShortTermPromotions } from "./short-term-promotion-apply.js";
import {
  configureMemoryCoreDreamingStateForTests,
  createPromotionCandidateForTest,
  resetMemoryCoreDreamingStateForTests,
} from "./test-helpers.js";

const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const initial = "# Memory\n\n- Existing synthetic preference.\n";
const fact = "The synthetic orchard uses blue labels for its pear trees.";

afterEach(() => {
  vi.restoreAllMocks();
  clearMemoryPluginState();
  resetMemoryCoreDreamingStateForTests();
  resetPluginStateStoreForTests();
});

async function withWorkspace(use: (workspace: string) => Promise<void>) {
  return withStateDirEnv("memory-promotion-provenance-", async ({ tempRoot }) => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
    await configureMemoryCoreDreamingStateForTests();
    registerMemoryCapability("memory-core", {
      runtime: createMemoryRuntime({ runInBackgroundContext: (run) => run() }),
    });
    await use(workspace);
  });
}

function trackedWriter(
  workspaceDir: string,
  origin: "agent" | "untrusted",
  physical = workspaceDir,
) {
  const target = (file: string) => path.join(physical, path.relative(workspaceDir, file));
  return withMemoryWriteProvenance(
    {
      readFile: (file: string) => fs.readFile(target(file)),
      writeFile: (file: string, content: string) => fs.writeFile(target(file), content),
    },
    createMemoryWriteProvenanceObserver({
      mutationRoot: workspaceDir,
      workspaceDir,
      resolvePath: async (file) => file,
      resolveOriginClass: () => origin,
    }),
  );
}

async function promote(workspaceDir: string) {
  return applyShortTermPromotions({
    workspaceDir,
    candidates: [
      createPromotionCandidateForTest({
        path: "memory/2026-11-18.md",
        snippet: fact,
        uniqueQueries: 3,
      }),
    ],
    nowMs: Date.parse("2026-11-18T12:00:00Z"),
  });
}

async function bootstrapMemory(workspaceDir: string) {
  const { contextFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
    config: { agents: { entries: { main: { workspace: workspaceDir } } } },
    agentId: "main",
    sessionKey: "agent:main:main",
  });
  return contextFiles.filter((file) => file.path.endsWith("MEMORY.md")).map((file) => file.content);
}

it.each(["agent", "untrusted"] as const)(
  "promotion and the next clean tracked edit preserve %s origin and bootstrap eligibility",
  (originClass) =>
    withWorkspace(async (workspace) => {
      const file = path.join(workspace, "MEMORY.md");
      const address = { workspaceDir: workspace, relativePath: "MEMORY.md" };
      await trackedWriter(workspace, originClass).writeFile(file, initial);
      await expect(readMemoryArtifactProvenance(address)).resolves.toMatchObject({
        originClass,
        fileHash: hash(initial),
      });
      await fs.writeFile(path.join(workspace, "memory/2026-11-18.md"), fact + "\n");
      expect(await promote(workspace)).toMatchObject({ applied: 1, appended: 1 });
      const promoted = await fs.readFile(file, "utf8");
      expect(promoted).toContain(fact);
      expect.soft(await readMemoryArtifactProvenance(address)).toMatchObject({
        originClass,
        fileHash: hash(promoted),
      });
      const edited = promoted + "\n- Another clean synthetic preference.\n";
      await trackedWriter(workspace, "agent").writeFile(file, edited);
      expect.soft(await readMemoryArtifactProvenance(address)).toMatchObject({
        originClass,
        fileHash: hash(edited),
      });
      expect(await bootstrapMemory(workspace)).toEqual(
        originClass === "agent" ? [edited.trimEnd()] : [],
      );
    }),
);

it("rejects a stale promotion preimage without changing content or provenance", () =>
  withWorkspace(async (workspace) => {
    const file = path.join(workspace, "MEMORY.md");
    const address = { workspaceDir: workspace, relativePath: "MEMORY.md" };
    await trackedWriter(workspace, "agent").writeFile(file, initial);
    const before = await readMemoryArtifactProvenance(address);
    await expect(
      commitMemoryContent({
        workspaceDir: workspace,
        filePath: file,
        tempPrefix: "MEMORY.md.promotion",
        expectedContent: "stale memory",
        expectedHash: hash("stale memory"),
        content: initial + fact,
      }),
    ).rejects.toMatchObject({ name: "MemoryWriteConflictError" });
    expect(await fs.readFile(file, "utf8")).toBe(initial);
    expect(await readMemoryArtifactProvenance(address)).toEqual(before);
  }));

it.each(["success", "committed", "uncertain"] as const)(
  "remote promotion retains Gateway-owned provenance for %s publication",
  (outcome) =>
    withWorkspace(async (workspace) => {
      const physical = path.join(workspace, "remote");
      await fs.mkdir(path.join(physical, "memory"), { recursive: true });
      const file = path.join(workspace, "MEMORY.md");
      const writer = trackedWriter(workspace, "agent", physical);
      await writer.writeFile(file, initial);
      await fs.writeFile(path.join(physical, "memory/2026-11-18.md"), fact + "\n");
      // A local decoy catches accidental Gateway filesystem reads during publication.
      await fs.writeFile(file, "Local decoy must remain untouched.\n");
      const files = createWorkspaceMemoryFileClient({
        workspaceDir: workspace,
        remoteWorkspaceDir: physical,
        signal: new AbortController().signal,
        request: async (request) => {
          let reply = "";
          const output = new Writable({
            write(chunk: Buffer, _encoding, callback) {
              reply += chunk.toString();
              callback();
            },
          });
          await serveMemoryFiles({ workspace: physical, input: Readable.from([request]), output });
          if (JSON.parse(request).method === "commitContent") {
            if (outcome === "uncertain") {
              throw new Error("Lost publication reply");
            }
            if (outcome === "committed") {
              return JSON.stringify({
                error: { message: "Post-rename sync failed", publication: "committed" },
              });
            }
          }
          return reply;
        },
        subscribe: async () => {
          throw new Error("No watch needed for promotion");
        },
      });
      const unexpected = async () => {
        throw new Error("Promotion must use the Memory file transport");
      };
      const release = registerAgentWorkspaceAccess(workspace, {
        memoryFiles: files,
        bridge: { readFile: unexpected, writeFile: unexpected, stat: unexpected },
      });
      const address = { workspaceDir: workspace, relativePath: "MEMORY.md" };
      const before = await readMemoryArtifactProvenance(address);
      try {
        if (outcome === "success") {
          expect(await promote(workspace)).toMatchObject({ applied: 1, appended: 1 });
        } else {
          await expect(promote(workspace)).rejects.toMatchObject({ publication: outcome });
        }
        const promoted = await fs.readFile(path.join(physical, "MEMORY.md"), "utf8");
        expect(promoted).toContain(fact);
        if (outcome === "uncertain") {
          expect(await readMemoryArtifactProvenance(address)).toEqual(before);
        } else {
          await expect(readMemoryArtifactProvenance(address)).resolves.toMatchObject({
            originClass: "agent",
            fileHash: hash(promoted),
          });
        }
        await writer.writeFile(file, promoted + "\n- Clean remote edit.\n");
        await expect(readMemoryArtifactProvenance(address)).resolves.toMatchObject({
          originClass: outcome === "uncertain" ? "untrusted" : "agent",
        });
        await expect(
          readMemoryArtifactProvenance({ workspaceDir: physical, relativePath: "MEMORY.md" }),
        ).resolves.toBeUndefined();
        expect(await fs.readFile(file, "utf8")).toBe("Local decoy must remain untouched.\n");
      } finally {
        release();
      }
    }),
);

it("reports committed content when the provenance store rejects recording", () =>
  withWorkspace(async (workspace) => {
    const file = path.join(workspace, "MEMORY.md");
    const address = { workspaceDir: workspace, relativePath: "MEMORY.md" };
    await trackedWriter(workspace, "agent").writeFile(file, initial);
    const before = await readMemoryArtifactProvenance(address);
    const createStore = pluginState.createCorePluginStateKeyedStore;
    vi.spyOn(pluginState, "createCorePluginStateKeyedStore").mockImplementation((options) => ({
      ...createStore(options),
      compareAndApply: async () => {
        throw new Error("Synthetic provenance write refusal");
      },
    }));
    const replacement = initial + fact;
    await expect(
      commitMemoryContent({
        workspaceDir: workspace,
        filePath: file,
        tempPrefix: "MEMORY.md.promotion",
        expectedHash: hash(initial),
        content: replacement,
      }),
    ).rejects.toMatchObject({
      publication: "committed",
      message: "Synthetic provenance write refusal",
    });
    expect(await fs.readFile(file, "utf8")).toBe(replacement);
    expect(await readMemoryArtifactProvenance(address)).toEqual(before);
  }));
