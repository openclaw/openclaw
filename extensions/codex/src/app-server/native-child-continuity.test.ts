import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import {
  buildDynamicToolsForTest,
  createParams,
  cleanupDynamicToolBuildFixture,
  bindProductionCodexHostCapabilities,
  hoisted,
} from "./dynamic-tool-build.test-support.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import { withLeasedCodexTestClient } from "./test-support.js";
import { startOrResumeThread } from "./thread-lifecycle.js";

// Integration of the real tool builder, bridge, binding store and thread lifecycle.
// The native app-server/task tree is a protocol fake, not live Codex E2E proof.
describe("native child continuity across source delivery turns", () => {
  let dir: string;
  const closers: Array<() => void> = [];
  beforeEach(async () => {
    hoisted.loadNodeExecAvailability.mockResolvedValue({
      cacheKey: "unavailable",
      isAvailable: () => false,
    });
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-child-continuity-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(dir, "state"));
    resetCodexTestBindingStore();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await cleanupDynamicToolBuildFixture(dir, closers);
  });

  it.each([
    { disableMessageTool: false, legacyCatalog: false },
    { disableMessageTool: true, legacyCatalog: false },
    { disableMessageTool: false, legacyCatalog: true },
    { disableMessageTool: true, legacyCatalog: true },
  ])(
    "preserves parent/child identity without message execution ($disableMessageTool, legacyCatalog=$legacyCatalog)",
    async ({ disableMessageTool, legacyCatalog }) => {
      const params = createParams(path.join(dir, "session.jsonl"), dir);
      params.disableTools = false;
      params.toolsAllow = ["sessions_spawn", "sessions_yield"];
      params.sourceReplyDeliveryMode = "message_tool_only";
      await bindProductionCodexHostCapabilities(params, closers);
      const onYieldDetected = vi.fn();
      const registration = {
        onYieldDetected,
        claimYieldCompletion: () => true,
        sandbox: null as never,
        forceHeartbeatTool: true,
        ignoreDisableMessageTool: true,
        ignoreRuntimePlan: true,
      };
      const initialTools = await buildDynamicToolsForTest(params, dir, registration);
      expect(initialTools.map((tool) => tool.name)).toContain("message");
      const initialSpecs = createCodexDynamicToolBridge({
        // Pre-upgrade automatic delivery omitted message from the saved native catalog.
        tools: legacyCatalog
          ? initialTools.filter((tool) => tool.name !== "message")
          : initialTools,
        signal: new AbortController().signal,
      }).specs;
      let nextParent = 0;
      const children = new Map<string, { parent: string; completed: boolean }>();
      const request = vi.fn(async (method: string, args?: unknown) => {
        const input = args as { threadId?: string; childId?: string };
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/start") {
          return threadStartResult("parent-" + ++nextParent, dir);
        }
        if (method === "thread/resume") {
          return threadStartResult(input.threadId!, dir);
        }
        if (method === "thread/read") {
          return {
            thread: {
              ...threadStartResult(input.threadId!, dir).thread,
              status: { type: "notLoaded" },
            },
          };
        }
        if (method === "test/spawn_agent") {
          children.set("implementation", { parent: input.threadId!, completed: false });
          return { id: "implementation" };
        }
        if (method === "test/followup_task") {
          const child = children.get(input.childId!);
          if (!child || child.parent !== input.threadId) {
            throw new Error("child belongs to another native parent");
          }
          return { id: input.childId, completed: child.completed };
        }
        return {};
      });
      await withLeasedCodexTestClient({
        agentDir: path.join(dir, "agent"),
        request,
        run: async (client) => {
          const common = {
            params,
            client,
            cwd: dir,
            signal: new AbortController().signal,
            bindingStore: testCodexAppServerBindingStore,
            appServer: {
              start: {
                transport: "stdio" as const,
                command: "codex",
                args: ["app-server"],
                headers: {},
              },
              codeModeOnly: false,
              loopDetectionPreToolUseRelay: true,
              requestTimeoutMs: 60_000,
              approvalPolicy: "never" as const,
              approvalsReviewer: "user" as const,
              sandbox: "workspace-write" as const,
              connectionClass: "local-loopback" as const,
              remoteAppsSubstrate: "preconfigured" as const,
            },
          };
          const first = await startOrResumeThread({ ...common, dynamicTools: initialSpecs });
          const child = await client.request<{ id: string }>(
            "test/spawn_agent",
            { threadId: first.threadId },
            { signal: common.signal },
          );
          const yielded = await createCodexDynamicToolBridge({
            tools: initialTools,
            signal: common.signal,
          }).handleToolCall({
            threadId: first.threadId,
            turnId: "initial-turn",
            callId: "yield",
            tool: "sessions_yield",
            arguments: {},
          });
          expect(yielded.success).toBe(true);
          expect(onYieldDetected).toHaveBeenCalledOnce();
          // The fake native child now completes; delivery resumes the owner in another turn.
          children.get("implementation")!.completed = true;
          params.runId = "completion-turn";
          params.sourceReplyDeliveryMode = undefined;
          params.disableMessageTool = disableMessageTool;
          const completionTools = await buildDynamicToolsForTest(params, dir, registration);
          const completionSpecs = createCodexDynamicToolBridge({
            tools: completionTools,
            signal: new AbortController().signal,
          }).specs;
          const resumed = await startOrResumeThread({ ...common, dynamicTools: completionSpecs });
          expect(resumed.threadId).toBe(first.threadId);
          if (!legacyCatalog) {
            expect(completionSpecs).toEqual(initialSpecs);
          }
          // A second adoption must retain the original fingerprint, not stamp a
          // widened catalog that the native thread never received.
          expect(
            (await startOrResumeThread({ ...common, dynamicTools: completionSpecs })).threadId,
          ).toBe(first.threadId);
          expect(
            await client.request(
              "test/followup_task",
              {
                threadId: resumed.threadId,
                childId: "implementation",
              },
              { signal: common.signal },
            ),
          ).toEqual({ ...child, completed: true });
          expect(nextParent).toBe(1);

          const executable = await buildDynamicToolsForTest(params, dir, {
            sandbox: null as never,
          });
          expect(executable.map((tool) => tool.name)).not.toContain("message");
          const bridge = createCodexDynamicToolBridge({
            tools: executable,
            registeredTools: completionTools,
            signal: new AbortController().signal,
          });
          const denied = await bridge.handleToolCall({
            threadId: resumed.threadId,
            turnId: "completion-turn",
            callId: "denied-message",
            tool: "message",
            arguments: { action: "send", target: "never-send", message: "denied" },
          });
          expect(denied.success).toBe(false);

          // A genuine declaration/schema change must still rotate an ordinary binding.
          const schemaChanged = structuredClone(completionSpecs);
          const changedFunction = schemaChanged.flatMap((spec) =>
            spec.type === "namespace" ? spec.tools : [spec],
          )[0]!;
          changedFunction.inputSchema = {
            type: "object",
            properties: { newRequired: { type: "string" } },
            required: ["newRequired"],
          };
          const changed = await startOrResumeThread({ ...common, dynamicTools: schemaChanged });
          expect(changed.threadId).not.toBe(first.threadId);

          // Persistent deny policy is not overridden by durable message registration.
          params.config = { ...params.config, tools: { deny: ["message"] } };
          await bindProductionCodexHostCapabilities(params, closers);
          const policyTools = await buildDynamicToolsForTest(params, dir, registration);
          expect(policyTools.map((tool) => tool.name)).not.toContain("message");
          const policyChanged = await startOrResumeThread({
            ...common,
            dynamicTools: createCodexDynamicToolBridge({
              tools: policyTools,
              signal: common.signal,
            }).specs,
          });
          expect(policyChanged.threadId).not.toBe(changed.threadId);
        },
      });
    },
  );
});
