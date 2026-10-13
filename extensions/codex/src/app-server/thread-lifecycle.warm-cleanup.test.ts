import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  protectCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import type { CodexDynamicToolFunctionSpec } from "./protocol.js";
import {
  createParams as createRunAttemptParams,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import * as sessionBinding from "./session-binding.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";
import {
  createLeasedCodexLifecycleHarness,
  startOrResumeAttemptThreadWithoutSkills as startOrResumeAttemptThread,
  type CodexAttemptThreadInput as LifecycleInput,
} from "./thread-lifecycle.test-fixtures.js";

function startOrResumeThread(input: Pick<LifecycleInput, "client"> & Partial<LifecycleInput>) {
  const cwd = input.cwd ?? input.params?.workspaceDir ?? path.join(tempDir, "workspace");
  const params = input.params ?? createParams(path.join(tempDir, "session.jsonl"), cwd);
  return startOrResumeAttemptThread({
    signal: new AbortController().signal,
    dynamicTools: [],
    appServer: createThreadLifecycleAppServerOptions(),
    ...input,
    params,
    cwd,
  });
}

function retainThread(
  client: LifecycleInput["client"],
  binding: Awaited<ReturnType<typeof startOrResumeThread>>,
) {
  return retainCodexAppServerLiveThread(
    client,
    binding.threadId,
    undefined,
    binding.liveThreadConfigFingerprint,
  );
}

function createThreadLifecycleAppServerOptions(): LifecycleInput["appServer"] {
  return {
    start: {
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      headers: {},
    },
    requestTimeoutMs: 60_000,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    codeModeOnly: false,
    loopDetectionPreToolUseRelay: true,
    connectionClass: "local-loopback",
  };
}

function createParams(sessionFile: string, workspaceDir: string) {
  const params = createRunAttemptParams(sessionFile, workspaceDir);
  params.disableTools = false;
  params.config = undefined;
  return params;
}

function createNamedDynamicTool(name: string): CodexDynamicToolFunctionSpec {
  return {
    type: "function",
    name,
    description: `${name} test tool`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
}

function createPluginAppConfigPatch(options: { approvalsReviewer?: "user" } = {}) {
  return {
    apps: {
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
      "google-calendar-app": {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
        ...(options.approvalsReviewer ? { approvals_reviewer: options.approvalsReviewer } : {}),
      },
    },
  };
}

function createPluginAppPolicyContext() {
  return {
    fingerprint: "plugin-policy-1",
    apps: {
      "google-calendar-app": {
        configKey: "google-calendar",
        marketplaceName: "openai-curated" as const,
        pluginName: "google-calendar",
        allowDestructiveActions: true,
        mcpServerNames: ["google-calendar"],
      },
    },
    pluginAppIds: {
      "google-calendar": ["google-calendar-app"],
    },
  };
}

setupRunAttemptTestHooks({ isolateNativeSkillHome: true });

describe("Codex warm subscription cleanup", () => {
  it("starts changed tool policy after warm publication loses its authority reader", async () => {
    const sessionFile = path.join(tempDir, "warm-publication-release.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const threadId = "warm-publication-thread";
    let starts = 0;
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond: async (method) => {
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/start") {
          starts += 1;
          return threadStartResult(starts === 1 ? threadId : "updated-policy-thread");
        }
        if (method === "thread/resume") {
          return threadStartResult(threadId);
        }
        throw new Error(`unexpected method: ${method}`);
      },
    });
    const common = {
      client: fixture.client,
      params,
      userMcpServersEnabled: false,
      developerInstructions: "original policy",
    };
    const started = await startOrResumeThread(common);
    expect(await retainThread(fixture.client, started)).toBe(true);
    fixture.seed(threadStartResult("active-sibling"), { loaded: true, subscribed: true });
    const sibling = await claimCodexAppServerLiveThread(fixture.client, "active-sibling");
    expect(sibling).toBeDefined();
    const readerFailure = new Error("warm publication reader release failed");
    const resolveBinding = sessionBinding.resolveCodexSessionBinding;
    const failedPublication = vi
      .spyOn(sessionBinding, "resolveCodexSessionBinding")
      .mockImplementationOnce(async (input) => {
        const resolved = await resolveBinding(input);
        const withCurrent = resolved.authority.withCurrent;
        return {
          ...resolved,
          authority: {
            ...resolved.authority,
            withCurrent: async (consume) => {
              const result = await withCurrent(consume);
              // Model a reader failing to release after the lifecycle published
              // its prepared binding; all earlier admissions use the real owner.
              if (
                result !== null &&
                typeof result === "object" &&
                "liveThreadOwnership" in result &&
                result.liveThreadOwnership
              ) {
                throw readerFailure;
              }
              return result;
            },
          },
        };
      });
    try {
      await expect(startOrResumeThread(common)).rejects.toBe(readerFailure);
      failedPublication.mockRestore();

      await expect(
        startOrResumeThread({
          ...common,
          developerInstructions: "updated policy",
          dynamicTools: [createNamedDynamicTool("updated_tool")],
        }),
      ).resolves.toMatchObject({
        threadId: "updated-policy-thread",
        lifecycle: { action: "started" },
      });
      expect(isCodexAppServerLiveThreadClaimed(fixture.client, threadId)).toBe(false);
      expect(() => sibling!.assertCurrent()).not.toThrow();
      expect(fixture.client.getCloseError()).toBeUndefined();
    } finally {
      failedPublication.mockRestore();
      await sibling?.release("active-sibling");
    }
  });

  it("keeps the original warm policy usable after rejecting rotation during native background work", async () => {
    const sessionFile = path.join(tempDir, "warm-background-policy-session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const threadId = "warm-background-policy-thread";
    let pluginFingerprint = "original-plugin-policy";
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond: async (method) => {
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/start") {
          return threadStartResult(threadId);
        }
        if (method === "app/installed") {
          return { apps: [{ id: "fixture-app", enabled: true, callable: true }] };
        }
        throw new Error(`unexpected method: ${method}`);
      },
    });
    const common = {
      client: fixture.client,
      params,
      userMcpServersEnabled: false,
      pluginThreadConfig: {
        enabled: true,
        requiresCurrentPolicyCheck: true,
        inputFingerprint: "stable-plugin-input",
        build: async () => ({
          enabled: true,
          fingerprint: pluginFingerprint,
          inputFingerprint: "stable-plugin-input",
          diagnostics: [],
          configPatch: createPluginAppConfigPatch(),
          policyContext: createPluginAppPolicyContext(),
          provisionalAppIds: ["fixture-app"],
        }),
      },
    };
    const started = await startOrResumeThread(common);
    expect(await retainThread(fixture.client, started)).toBe(true);
    const bindingBefore = await readCodexAppServerBinding(sessionFile);
    // Native commands keep the original physical subscription protected after
    // its foreground turn finishes; policy refusal must not steal its idle owner.
    const releaseProtection = protectCodexAppServerLiveThread(fixture.client, threadId);
    fixture.request.mockClear();
    try {
      pluginFingerprint = "changed-plugin-policy";
      await expect(startOrResumeThread(common)).rejects.toThrow(
        `Codex thread ${threadId} is claimed by active work; stop it first.`,
      );
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(bindingBefore);
      expect(
        fixture.request.mock.calls.some(([method]) =>
          ["thread/start", "thread/resume", "thread/unsubscribe"].includes(method),
        ),
      ).toBe(false);

      pluginFingerprint = "original-plugin-policy";
      await expect(startOrResumeThread(common)).resolves.toMatchObject({
        threadId,
        lifecycle: { action: "resumed" },
      });
      expect(
        fixture.request.mock.calls.some(([method]) =>
          ["thread/start", "thread/resume", "thread/unsubscribe"].includes(method),
        ),
      ).toBe(false);
      expect(fixture.client.getCloseError()).toBeUndefined();
    } finally {
      releaseProtection();
    }
  });
});
