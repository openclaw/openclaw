// Codex tests cover frozen workspace policy across physical thread replacement.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_UNAVAILABLE_PROJECT_DOCS_AUTHORITY,
  sessionBindingIdentity,
} from "./session-binding.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  createAppServerOptions,
  createParams,
  resetThreadLifecycleTestFixtures,
  startOrResumeThread,
  threadStartResult,
} from "./thread-lifecycle.test-fixtures.js";

describe("Codex app-server rotated workspace policy", () => {
  beforeEach(() => {
    resetCodexTestBindingStore();
  });

  afterEach(() => {
    resetThreadLifecycleTestFixtures();
    vi.restoreAllMocks();
  });

  it("does not replay frozen project instructions when lifecycle policy rotates", async () => {
    const workspaceDir = "/tmp/openclaw-codex-rotated-workspace-policy";
    const capturedRootGuidance = "Keep the original root instructions for this session.";
    const capturedNestedGuidance = "Keep the original nested instructions for this session.";
    const replacementGuidance = "Changed B instructions belong only to a new session.";
    const capturedGuidance = `${capturedRootGuidance}\n${capturedNestedGuidance}`;
    const developerInstructions = `Frozen Codex Project Instructions\n${capturedGuidance}`;
    const attempt = createParams("/tmp/openclaw-codex-rotated-policy.jsonl", workspaceDir);
    let startCount = 0;
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start") {
        startCount += 1;
        return threadStartResult(`thread-${startCount}`);
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const dynamicTool = (name: string) => ({
      type: "function" as const,
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
    });
    const common = {
      client: { request } as never,
      params: attempt,
      cwd: workspaceDir,
      dynamicTools: [dynamicTool("workspace-tool-a")],
      developerInstructions,
      coldDeveloperInstructions: developerInstructions,
      agentWorkspaceDeveloperInstructions: capturedGuidance,
      agentWorkspaceDeveloperInstructionsAllowed: true,
      nativeProjectInstructionSnapshotAllowed: true,
      config: { project_doc_max_bytes: 64_000 },
      appServer: createAppServerOptions(),
    };

    await startOrResumeThread(common);
    const replacement = await startOrResumeThread({
      ...common,
      dynamicTools: [dynamicTool("workspace-tool-b")],
      developerInstructions: `Frozen Codex Project Instructions\n${replacementGuidance}`,
      nativeProjectDocsDisabledOnResume: true,
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
      "config/read",
      "configRequirements/read",
      "config/read",
      "thread/start",
    ]);
    const replacementRequest = request.mock.calls.findLast(
      ([method]) => method === "thread/start",
    )?.[1] as
      | { config?: { project_doc_max_bytes?: number }; developerInstructions?: string }
      | undefined;
    expect(replacementRequest?.config?.project_doc_max_bytes).not.toBe(0);
    expect(replacementRequest?.developerInstructions).toContain(replacementGuidance);
    expect(replacementRequest?.developerInstructions).not.toContain(capturedRootGuidance);
    expect(replacementRequest?.developerInstructions).not.toContain(capturedNestedGuidance);
    expect(replacement).toMatchObject({
      threadId: "thread-2",
    });
    expect(replacement.agentWorkspaceDeveloperInstructions).not.toBe(capturedGuidance);
    expect(
      testCodexAppServerBindingStore.read(
        sessionBindingIdentity({
          sessionId: attempt.sessionId,
          sessionKey: attempt.sessionKey,
          agentId: attempt.agentId,
          config: attempt.config,
        }),
      ),
    ).toMatchObject({
      threadId: "thread-2",
    });
  });

  it("does not capture Gateway-local instructions for a remote replacement", async () => {
    const workspaceDir = "/tmp/openclaw-codex-remote-rotation";
    const attempt = createParams("/tmp/openclaw-codex-remote-rotation.jsonl", workspaceDir);
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start") {
        const startNumber = request.mock.calls.filter(([name]) => name === "thread/start").length;
        return {
          ...threadStartResult(`thread-${startNumber}`),
          instructionSources: startNumber === 2 ? ["/remote/workspace/AGENTS.md"] : [],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const common = {
      client: { request } as never,
      params: attempt,
      cwd: workspaceDir,
      dynamicTools: [
        {
          type: "function" as const,
          name: "remote-tool",
          description: "remote-tool",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      developerInstructions: "Current turn instructions.",
      coldDeveloperInstructions: "Old frozen instructions.",
      agentWorkspaceDeveloperInstructions: "Old frozen instructions.",
      agentWorkspaceDeveloperInstructionsAllowed: true,
      nativeProjectInstructionSnapshotAllowed: false,
      environmentSelection: [{ environmentId: "remote-a", cwd: "/remote/workspace" }],
      appServer: createAppServerOptions(),
    };
    await startOrResumeThread(common);
    const replacement = await startOrResumeThread({
      ...common,
      dynamicTools: [
        {
          type: "function" as const,
          name: "replacement-tool",
          description: "replacement-tool",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      nativeProjectDocsDisabledOnResume: true,
    });
    expect(replacement.threadId).toBe("thread-2");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
      "config/read",
      "configRequirements/read",
      "thread/start",
    ]);
    expect(replacement.agentWorkspaceDeveloperInstructions).toBe(
      CODEX_UNAVAILABLE_PROJECT_DOCS_AUTHORITY,
    );
    expect(replacement.projectInstructionsUnavailableToGateway).toBe(true);
    const replacementStart = request.mock.calls.findLast(
      ([method]) => method === "thread/start",
    )?.[1] as
      | { config?: { project_doc_max_bytes?: number }; developerInstructions?: string }
      | undefined;
    expect(replacementStart?.config?.project_doc_max_bytes).not.toBe(0);
    expect(replacementStart?.developerInstructions).not.toContain("Old frozen instructions.");
  });
});
