import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, expect, it } from "vitest";
import { readMemoryArtifactProvenance } from "../memory/memory-artifact-provenance.js";
import { clearMemoryPluginState, registerMemoryCapability } from "../plugins/memory-state.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createOpenClawCodingToolsInternalAsync } from "./agent-tools.async.js";
import { resolveBootstrapContextForRun } from "./bootstrap-files.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { createContainerWorkspaceSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

afterEach(() => clearMemoryPluginState());

// No search is needed: bootstrap uses the host's real provenance classifier/store.
function registerMemory() {
  registerMemoryCapability("memory-fixture", {
    runtime: {
      getMemorySearchManager: async () => {
        throw new Error("Unexpected search");
      },
      resolveMemoryBackendConfig: () => ({ backend: "builtin" }),
    },
  });
}

it.each([
  ["canonical", "write"],
  ["session-rooted", "write"],
  ["session-rooted", "edit"],
  ["session-rooted-tainted", "write"],
] as const)(
  "records canonical workspace memory after a %s %s and clean edit",
  async (rootKind, writer) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ workspaceDir }) => {
      registerMemory();
      const sessionRoot = path.join(workspaceDir, "projects", "task");
      await fs.mkdir(sessionRoot, { recursive: true });
      const config = { agents: { entries: { main: { workspace: workspaceDir } } } };
      const toolsFor = (root: string, tainted = false) =>
        createOpenClawCodingToolsInternalAsync({
          config,
          agentId: "main",
          workspaceDir: root,
          cwd: root,
          senderIsOwner: true,
          isTurnTainted: () => tainted,
          toolConstructionPlan: {
            includeBaseCodingTools: true,
            includeShellTools: false,
            includeChannelTools: false,
            includeOpenClawTools: false,
            includePluginTools: false,
          },
        });
      const canonical = await toolsFor(workspaceDir);
      const tainted = rootKind === "session-rooted-tainted";
      const rooted = await toolsFor(rootKind === "canonical" ? workspaceDir : sessionRoot, tainted);
      const seed = canonical.find((tool) => tool.name === "write");
      const mutate = rooted.find((tool) => tool.name === writer);
      const cleanEdit = canonical.find((tool) => tool.name === "edit");
      assert(seed && mutate && cleanEdit);
      const files = ["MEMORY.md", "USER.md", "memory/nested/note.md"];
      const bootstrap = async () =>
        (await resolveBootstrapContextForRun({ workspaceDir, config, agentId: "main" }))
          .contextFiles;
      for (const relativePath of files) {
        const target = path.join(workspaceDir, relativePath);
        await seed.execute(`seed-${relativePath}`, { path: target, content: "seed\n" });
        expect(await readMemoryArtifactProvenance({ workspaceDir, relativePath })).toMatchObject({
          originClass: "agent",
          fileHash: createHash("sha256").update("seed\n").digest("hex"),
        });
      }
      expect((await bootstrap()).map((file) => file.path)).toEqual(
        expect.arrayContaining([
          path.join(workspaceDir, "MEMORY.md"),
          path.join(workspaceDir, "USER.md"),
        ]),
      );
      for (const relativePath of files) {
        const target = path.join(workspaceDir, relativePath);
        await mutate.execute(
          `rooted-${relativePath}`,
          writer === "write"
            ? { path: target, content: "rooted\n" }
            : { path: target, edits: [{ oldText: "seed", newText: "rooted" }] },
        );
        expect(await fs.readFile(target, "utf8")).toBe("rooted\n");
        // Soft checks keep the subsequent clean edit and injection assertion reachable.
        expect
          .soft(await readMemoryArtifactProvenance({ workspaceDir, relativePath }))
          .toMatchObject({
            originClass: tainted ? "untrusted" : "agent",
            fileHash: createHash("sha256").update("rooted\n").digest("hex"),
          });
        await cleanEdit.execute(`clean-${relativePath}`, {
          path: target,
          edits: [{ oldText: "rooted", newText: "clean" }],
        });
        expect
          .soft(await readMemoryArtifactProvenance({ workspaceDir, relativePath }))
          .toMatchObject({
            originClass: tainted ? "untrusted" : "agent",
            fileHash: createHash("sha256").update("clean\n").digest("hex"),
          });
      }
      expect
        .soft(
          (await bootstrap()).filter((file) =>
            files.slice(0, 2).some((name) => file.path === path.join(workspaceDir, name)),
          ),
        )
        .toEqual(
          tainted
            ? []
            : expect.arrayContaining([
                expect.objectContaining({
                  path: path.join(workspaceDir, "MEMORY.md"),
                  content: "clean",
                }),
                expect.objectContaining({
                  path: path.join(workspaceDir, "USER.md"),
                  content: "clean",
                }),
              ]),
        );
      // Daily notes are not direct bootstrap files; their row is asserted above.
    });
  },
);

it.each(["session-local", "sandbox"] as const)(
  "keeps %s memory separate from canonical agent memory",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ workspaceDir }) => {
      const root = path.join(workspaceDir, "projects", mode);
      await fs.mkdir(root, { recursive: true });
      const tools = await createOpenClawCodingToolsInternalAsync({
        config: { agents: { entries: { main: { workspace: workspaceDir } } } },
        agentId: "main",
        workspaceDir: root,
        cwd: root,
        senderIsOwner: true,
        sandbox:
          mode === "sandbox"
            ? createAgentToolsSandboxContext({
                workspaceDir: root,
                agentWorkspaceDir: workspaceDir,
                workspaceAccess: "none",
                fsBridge: createContainerWorkspaceSandboxFsBridge(root),
              })
            : undefined,
        toolConstructionPlan: {
          includeBaseCodingTools: true,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: false,
          includePluginTools: false,
        },
      });
      const write = tools.find((tool) => tool.name === "write");
      assert(write);
      for (const relativePath of ["MEMORY.md", "USER.md", "memory/local.md"]) {
        await write.execute(relativePath, { path: relativePath, content: "local memory" });
        expect(
          await readMemoryArtifactProvenance({ workspaceDir: root, relativePath }),
        ).toMatchObject({ originClass: "agent" });
        expect(await readMemoryArtifactProvenance({ workspaceDir, relativePath })).toBeUndefined();
      }
    });
  },
);
