import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE } from "../../bootstrap-files.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../../workspace-bootstrap-read.js";
import { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const addedTempDirs = useAutoCleanupTempDirTracker(afterEach);
const contextFile = (filePath: string, content: unknown) =>
  expect.objectContaining({ path: filePath, content });

async function makeWorkspace(label: string, files: Record<string, string> = {}): Promise<string> {
  const workspace = await fs.realpath(addedTempDirs.make(`openclaw-${label}-`));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(workspace, name), content);
  }
  return workspace;
}

describe("prepareEmbeddedAttemptBootstrap", () => {
  async function prepare(
    agentWorkspace: string,
    sessionWorkspace = agentWorkspace,
    options: {
      contextInjection?: "always" | "continuation-skip" | "never";
      effectiveWorkspace?: string;
      isRawModelRun?: boolean;
      attempt?: Partial<EmbeddedRunAttemptParams>;
    } = {},
  ) {
    const defaults = {
      workspace: agentWorkspace,
      ...(options.contextInjection ? { contextInjection: options.contextInjection } : {}),
    };
    return await prepareEmbeddedAttemptBootstrap({
      attempt: {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        trigger: "user",
        bootstrapWorkspaceDir: agentWorkspace,
        isCanonicalWorkspace: agentWorkspace === sessionWorkspace,
        config: { agents: { defaults } },
        ...options.attempt,
      } as EmbeddedRunAttemptParams,
      setup: createAttemptSetupFixture({
        effectiveWorkspace: options.effectiveWorkspace ?? sessionWorkspace,
        resolvedWorkspace: sessionWorkspace,
      }),
      hasReadTool: true,
      isRawModelRun: options.isRawModelRun ?? false,
    });
  }

  it.each([
    {
      mode: "always",
      pending: false,
      canonical: true,
      runKind: "default",
      contextMode: "full",
      bootstrapMode: "none",
      completion: false,
      injected: true,
    },
    {
      mode: "always",
      pending: true,
      canonical: true,
      runKind: "default",
      contextMode: "full",
      bootstrapMode: "full",
      completion: true,
      injected: true,
    },
    {
      mode: "continuation-skip",
      pending: false,
      canonical: true,
      runKind: "default",
      contextMode: "full",
      bootstrapMode: "none",
      completion: true,
      injected: true,
    },
    {
      mode: "continuation-skip",
      pending: false,
      canonical: true,
      runKind: "cron",
      contextMode: "full",
      bootstrapMode: "none",
      completion: false,
      injected: true,
    },
    {
      mode: "continuation-skip",
      pending: false,
      canonical: true,
      runKind: "heartbeat",
      contextMode: "full",
      bootstrapMode: "none",
      completion: false,
      injected: true,
    },
    {
      mode: "continuation-skip",
      pending: false,
      canonical: true,
      runKind: "default",
      contextMode: "lightweight",
      bootstrapMode: "none",
      completion: false,
      injected: false,
    },
    {
      mode: "continuation-skip",
      pending: true,
      canonical: false,
      runKind: "default",
      contextMode: "full",
      bootstrapMode: "limited",
      completion: false,
      injected: true,
    },
    {
      mode: "never",
      pending: true,
      canonical: true,
      runKind: "default",
      contextMode: "full",
      bootstrapMode: "full",
      completion: false,
      injected: false,
    },
  ] as const)(
    "completion follows delivered context: $mode / pending=$pending / $runKind / $contextMode",
    async (testCase) => {
      const workspace = await makeWorkspace("completion-workspace", {
        "AGENTS.md": "Workspace instructions",
        ...(testCase.pending ? { "BOOTSTRAP.md": "Finish the workspace setup." } : {}),
      });
      const result = await prepare(workspace, workspace, {
        contextInjection: testCase.mode,
        attempt: {
          isCanonicalWorkspace: testCase.canonical,
          bootstrapContextRunKind: testCase.runKind,
          bootstrapContextMode: testCase.contextMode,
        },
      });

      expect(result).toMatchObject({
        bootstrapMode: testCase.bootstrapMode,
        shouldRecordCompletedBootstrapTurn: testCase.completion,
      });
      expect(result.contextFiles.some((file) => file.content === "Workspace instructions")).toBe(
        testCase.injected,
      );
      if (!testCase.injected) {
        expect(result.contextFiles).toEqual([]);
        expect(result.bootstrapInjectionStats).toEqual([]);
      }
    },
  );

  it("skips injection for a completed limited-bootstrap continuation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const workspace = state.workspaceDir;
      await fs.writeFile(path.join(workspace, "AGENTS.md"), "Already delivered instructions");
      await fs.writeFile(path.join(workspace, "BOOTSTRAP.md"), "Finish the workspace setup.");
      const sessionTarget = {
        agentId: "main",
        sessionId: "completed-bootstrap-session",
        sessionKey: "agent:main:completed-bootstrap-session",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      await upsertSessionEntryCore(sessionTarget, {
        sessionId: sessionTarget.sessionId,
        updatedAt: Date.now(),
      });
      const sessionManager = await SessionManager.openAsync(sessionTarget, workspace);
      await sessionManager.appendCustomEntryAsync(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, {
        timestamp: 1,
      });

      const result = await prepare(workspace, workspace, {
        contextInjection: "continuation-skip",
        attempt: {
          sessionId: sessionTarget.sessionId,
          sessionKey: sessionTarget.sessionKey,
          sessionTarget,
          isCanonicalWorkspace: false,
        },
      });

      expect(result).toMatchObject({
        bootstrapMode: "limited",
        contextFiles: [],
        bootstrapInjectionStats: [],
        shouldRecordCompletedBootstrapTurn: false,
      });
    });
  });

  it.each(["raw", "settled"] as const)(
    "withholds ambient context for %s model work",
    async (kind) => {
      const workspace = await makeWorkspace("isolated-workspace", {
        "AGENTS.md": "Ambient instructions must stay out",
      });
      const result = await prepare(workspace, workspace, {
        isRawModelRun: kind === "raw",
        attempt: kind === "settled" ? { operation: "settled-tool-finalization" } : {},
      });

      expect(result).toMatchObject({
        contextFiles: [],
        bootstrapInjectionStats: [],
        shouldRecordCompletedBootstrapTurn: false,
      });
    },
  );

  it("layers execution project instructions after agent bootstrap files", async () => {
    const agentWorkspace = await makeWorkspace("agent-workspace", {
      "AGENTS.md": "Canonical agent instructions",
      "SOUL.md": "Canonical agent soul",
    });
    const sessionWorkspace = await makeWorkspace("session-workspace", {
      "AGENTS.md": "Execution project context",
      "SOUL.md": "Execution soul must stay private",
    });

    const result = await prepare(agentWorkspace, sessionWorkspace);
    const executionAgentsIndex = result.contextFiles.findIndex(
      (file) => file.path === path.join(sessionWorkspace, "AGENTS.md"),
    );
    const lastAgentFileIndex = result.contextFiles.findLastIndex((file) =>
      file.path.startsWith(`${agentWorkspace}${path.sep}`),
    );

    expect(executionAgentsIndex).toBeGreaterThan(lastAgentFileIndex);
    expect(
      result.bootstrapInjectionStats.filter((file) => file.name === "AGENTS.md"),
    ).toMatchObject([
      {
        path: path.join(agentWorkspace, "AGENTS.md"),
        origin: { kind: "agent-workspace", rootPath: agentWorkspace },
      },
      {
        path: path.join(sessionWorkspace, "AGENTS.md"),
        origin: { kind: "execution-project", rootPath: sessionWorkspace },
      },
    ]);
    expect(result.contextFiles[executionAgentsIndex]).toMatchObject({
      path: path.join(sessionWorkspace, "AGENTS.md"),
      content: "Execution project context",
    });
    expect(result.contextFiles).toContainEqual(
      contextFile(path.join(agentWorkspace, "SOUL.md"), "Canonical agent soul"),
    );
    expect(result.contextFiles).not.toContainEqual(
      expect.objectContaining({ path: path.join(sessionWorkspace, "SOUL.md") }),
    );
  });

  it.each(["none", "full"])("withholds completion for unreadable AGENTS.md (%s)", async (mode) => {
    const unreadable = "x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES + 1);
    const agentWorkspace = await makeWorkspace("agent-workspace", {
      "AGENTS.md": mode === "full" ? unreadable : "Canonical agent instructions",
      ...(mode === "full" ? { "BOOTSTRAP.md": "Finish the workspace setup." } : {}),
    });
    const sessionWorkspace =
      mode === "full"
        ? agentWorkspace
        : await makeWorkspace("session-workspace", { "AGENTS.md": unreadable });

    const result = await prepare(agentWorkspace, sessionWorkspace, {
      contextInjection: "continuation-skip",
    });

    expect(result).toMatchObject({
      bootstrapMode: mode,
      shouldRecordCompletedBootstrapTurn: false,
    });
    if (mode === "full") {
      return;
    }
    expect(result.contextFiles).toContainEqual(
      contextFile(
        path.join(sessionWorkspace, "AGENTS.md"),
        expect.stringMatching(/^\[UNREADABLE: File exceeds/),
      ),
    );

    await fs.writeFile(path.join(sessionWorkspace, "AGENTS.md"), "Recovered instructions");
    const recovered = await prepare(agentWorkspace, sessionWorkspace, {
      contextInjection: "continuation-skip",
    });
    expect(recovered.shouldRecordCompletedBootstrapTurn).toBe(true);
    expect(recovered.contextFiles).toContainEqual(
      expect.objectContaining({ content: "Recovered instructions" }),
    );
  });

  it("remaps injected paths into the prompt workspace while accounting keeps source paths", async () => {
    const agents = "Sandboxed agent instructions";
    const workspace = await makeWorkspace("remap-workspace", { "AGENTS.md": agents });
    const promptWorkspace = await makeWorkspace("remap-prompt");

    const result = await prepare(workspace, workspace, {
      effectiveWorkspace: promptWorkspace,
    });

    expect(result.contextFiles).toContainEqual(
      contextFile(path.join(promptWorkspace, "AGENTS.md"), agents),
    );
    expect(result.bootstrapInjectionStats).toContainEqual(
      expect.objectContaining({
        path: path.join(workspace, "AGENTS.md"),
        rawChars: agents.length,
        injectedChars: agents.length,
        truncated: false,
      }),
    );
  });

  it("selects the current person's agent-workspace overlay across attempt switches", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const workspace = state.statePath("workspace");
      const alice = ensureProfileForEmail("alice@example.test");
      const bob = ensureProfileForEmail("bob@example.test");
      for (const profile of [alice, bob]) {
        const dir = path.join(workspace, "users", profile.id);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
          path.join(dir, "USER.md"),
          profile.id === alice.id ? "Alice guidance" : "Bob guidance",
        );
      }
      await fs.writeFile(path.join(workspace, "USER.md"), "Shared guidance");
      for (const profile of [alice, bob, undefined]) {
        const result = await prepare(workspace, workspace, {
          attempt: {
            sessionId: "same-session",
            sessionKey: "agent:main:same-session",
            bootstrapUserProfileId: profile?.id,
          },
        });
        const context = result.contextFiles.map((file) => file.content).join("\n");
        expect(context).toContain("Shared guidance");
        expect(context.includes("Alice guidance")).toBe(profile === alice);
        expect(context.includes("Bob guidance")).toBe(profile === bob);
      }
    });
  });

  it("keeps same-workspace bootstrap output byte-identical", async () => {
    const workspace = await makeWorkspace("same-workspace", {
      "AGENTS.md": "Same workspace instructions",
      "SOUL.md": "Same workspace soul",
    });

    const explicit = await prepare(workspace);
    const omitted = await prepare(workspace, workspace, {
      attempt: { bootstrapWorkspaceDir: undefined },
    });

    expect(explicit).toEqual(omitted);
  });
});
