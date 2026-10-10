/** Real exec/process -> ordinary session-event -> channel-boundary regression. */
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { dispatchInboundMessageWithRoutedChannelDispatcher } from "../auto-reply/dispatch.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import { enqueueSessionEventForHost as enqueueSessionEvent } from "../auto-reply/reply/session-event-handoff.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "./admitted-run-context.js";
import { createOpenClawCodingToolsAsync } from "./agent-tools.js";
import { getFinishedSession, waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createProcessTool } from "./bash-tools.process.js";
import { createAgentHarnessHostCapabilities } from "./harness/host-capability.js";
import { acknowledgeInternalToolResult } from "./runtime/internal-hooks.js";
import { createSubagentRunRecord } from "./subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagents/registry/subagent-registry-memory.js";
import type { AnyAgentTool } from "./tools/common.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const dispatchMock = vi.hoisted(() =>
  vi.fn<typeof dispatchInboundMessageWithRoutedChannelDispatcher>(),
);
const sendTextMock = vi.hoisted(() =>
  vi.fn(async () => ({
    channel: "telegram" as const,
    messageId: "synthetic-message",
    chatId: "100123",
  })),
);
// mock-isolation: Use synthetic model dispatch with real event admission and outbound delivery.
vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: dispatchMock,
}));
vi.mock("../auto-reply/reply/session-event-handoff.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../auto-reply/reply/session-event-handoff.js")>();
  return { ...actual, enqueueSessionEventForHost: vi.fn(actual.enqueueSessionEventForHost) };
});

const RUN_ID = "visible-exec-channel-fixture";
const sourceOwners: Array<{ close: () => void }> = [];
let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "exec-visible-owner-" });
  vi.mocked(enqueueSessionEvent).mockClear();
  sendTextMock.mockClear();
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: createOutboundTestPlugin({
          id: "telegram",
          outbound: { deliveryMode: "direct", sendText: sendTextMock },
        }),
      },
    ]),
  );
  // Model execution is synthetic; event admission, routing, and outbound delivery are real.
  dispatchMock.mockReset().mockImplementation(async ({ ctx, replyOptions, dispatcherOptions }) => {
    const operation = createReplyOperation({
      sessionKey: String(ctx.SessionKey),
      sessionId: replyOptions!.expectedExistingSessionId!,
      turnKind: "queued_followup",
      resetTriggered: false,
    });
    try {
      await replyOptions!.turnAdoptionLifecycle!.onAdopted();
      await replyOptions!.internalEventExecution!.beforeStart?.();
      replyOptions!.internalEventExecution!.onStarted(RUN_ID);
      await dispatcherOptions.deliver(
        { text: "The background build exited with code 7." },
        { kind: "final" },
      );
      await replyOptions!.internalEventExecution!.onTerminal(RUN_ID, "completed");
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    } finally {
      operation.complete();
    }
  });
});
afterEach(async () => {
  for (const owner of sourceOwners.splice(0).toReversed()) {
    owner.close();
  }
  subagentRuns.delete(RUN_ID);
  clearAgentRunContext(RUN_ID);
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  await state.cleanup();
});

it.skipIf(process.platform === "win32").each([
  {
    kind: "visible child borrowing parent tool policy",
    sessionKey: "agent:main:dashboard:borrowed",
    child: true,
    borrowedPolicy: true,
  },
  {
    kind: "automation with no fallback delivery routed to main",
    sessionKey: "agent:main:cron:private-job:run:execution",
    eventSessionKey: "agent:main:main",
    child: false,
    privateDelivery: true,
  },
  {
    kind: "message-tool-only automation routed to main",
    sessionKey: "agent:main:cron:message-only-job:run:execution",
    eventSessionKey: "agent:main:main",
    child: false,
    messageToolOnly: true,
  },
  {
    kind: "restricted automation routed to a broader main session",
    sessionKey: "agent:main:cron:restricted-job:run:execution",
    eventSessionKey: "agent:main:main",
    child: false,
    restrictedTools: true,
  },
  { kind: "hidden child", sessionKey: "agent:main:subagent:hidden", child: true },
  {
    kind: "dashboard with only a navigation parent",
    sessionKey: "agent:main:dashboard:navigation",
    child: false,
    navigation: true,
  },
])(
  "keeps a real failed background exec owned by its $kind",
  async ({
    sessionKey,
    child,
    navigation,
    borrowedPolicy,
    privateDelivery,
    eventSessionKey,
    restrictedTools,
    messageToolOnly,
  }) => {
    const silentDelivery = privateDelivery || messageToolOnly;
    const tmpDir = state.root;
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tmpDir } },
      channels: { telegram: { allowFrom: ["*"] } },
      session: { store: storePath },
      ...(restrictedTools || messageToolOnly
        ? { tools: { profile: "coding" as const, codeMode: false, toolSearch: false } }
        : {}),
    };
    setRuntimeConfigSnapshot(cfg);
    const delivery = normalizeSessionDeliveryState({
      context: { channel: "telegram", to: "100123" },
    });
    await replaceSessionEntry(
      { storePath, agentId: "main", sessionKey: "agent:main:main" },
      {
        sessionId: "main-fixture",
        updatedAt: Date.now(),
        delivery,
      },
    );
    if (sessionKey !== "agent:main:main") {
      await replaceSessionEntry(
        { storePath, agentId: "main", sessionKey },
        {
          sessionId: "dashboard-fixture",
          updatedAt: Date.now(),
          delivery,
          ...(child ? { spawnDepth: 1, spawnedBy: "agent:main:main" } : {}),
          ...(navigation ? { spawnedBy: "agent:main:main" } : {}),
        },
      );
    }
    const scriptFile = path.join(tmpDir, "background-child.cjs");
    const releaseFile = path.join(tmpDir, "release-child");
    await fs.writeFile(
      scriptFile,
      [
        'const fs = require("node:fs");',
        `const releaseFile = ${JSON.stringify(releaseFile)};`,
        'const finish = () => { if (fs.existsSync(releaseFile)) { watcher.close(); process.stdout.write("synthetic failed build\\n"); process.exit(7); } };',
        `const watcher = fs.watch(${JSON.stringify(tmpDir)}, finish);`,
        "finish();",
      ].join("\n"),
    );
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const exec = createExecTool({
      config: cfg,
      host: "gateway",
      security: "full",
      ask: "off",
      allowBackground: true,
      timeoutSec: 10,
      notifyOnExit: true,
      sessionKey: borrowedPolicy ? "agent:main:main" : sessionKey,
      ...(borrowedPolicy ? { runSessionKey: sessionKey } : {}),
      scopeKey: sessionKey,
      messageProvider: "telegram",
      currentChannelId: "100123",
    });
    const toolOptions = {
      config: cfg,
      agentId: "main",
      sessionId: "dashboard-fixture",
      sessionKey,
      runSessionKey: sessionKey,
      runId: RUN_ID,
      inheritRuntimeToolAllowlist: true,
      ...(messageToolOnly ? { sourceReplyDeliveryMode: "message_tool_only" as const } : {}),
      workspaceDir: tmpDir,
      cwd: tmpDir,
      exec: {
        host: "gateway" as const,
        security: "full" as const,
        ask: "off" as const,
        allowBackground: true,
        timeoutSec: 10,
        notifyOnExit: true,
      },
      toolConstructionPlan: {
        includeBaseCodingTools: true,
        includeShellTools: true,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    };
    let producerExec: AnyAgentTool | undefined;
    if (restrictedTools || messageToolOnly) {
      const admission = prepareAgentRunAdmission({
        cfg,
        admissionSource: "operator-schedule",
        operationalRunInstance: createOperationalRunInstanceRef(RUN_ID),
        facts: {
          runId: RUN_ID,
          agentId: "main",
          ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
        },
      });
      sourceOwners.push(admission);
      const host = createAgentHarnessHostCapabilities({
        attempt: {
          ...toolOptions,
          admittedRunContext: await admission.admit("embedded"),
        },
        pluginId: "openclaw",
      });
      sourceOwners.push(host);
      const tools = await expectDefined(
        host.capabilities.createToolSurfaceAsync,
        "producer tool construction",
      )({ ...toolOptions, runtimeToolAllowlist: ["exec", "process"] });
      expect(tools.map((tool) => tool.name).toSorted()).toEqual(["exec", "process"]);
      producerExec = expectDefined(
        tools.find((tool) => tool.name === "exec"),
        "producer exec",
      );
    }
    if (privateDelivery) {
      registerAgentRunContext(RUN_ID, { sessionKey, agentId: "main", sessionEventDelivery: false });
    }
    const started = await withGatewayToolCallerIdentity(
      privateDelivery
        ? {
            agentId: "main",
            sessionKey,
            operationalRunInstance: createOperationalRunInstanceRef(RUN_ID),
            receiptAuthority: () => true,
          }
        : undefined,
      () =>
        (producerExec ?? exec).execute("background-child", {
          command: `${quote(process.execPath)} ${quote(scriptFile)}`,
          background: true,
        }),
    );
    // Completion retains its producer's policy after the original turn closes.
    clearAgentRunContext(RUN_ID);
    const details = asOptionalRecord(started.details);
    if (details?.status !== "running" || typeof details.sessionId !== "string") {
      throw new Error(`Expected running exec, received ${String(details?.status)}`);
    }
    const sessionId = details.sessionId;
    // Registration can follow child dispatch. Both registration and retirement
    // happen while the real background process is waiting, before it exits.
    if (child) {
      subagentRuns.set(
        RUN_ID,
        createSubagentRunRecord({ runId: RUN_ID, childSessionKey: sessionKey }),
      );
    }
    subagentRuns.delete(RUN_ID);
    const processTool = createProcessTool({ scopeKey: sessionKey });
    await fs.writeFile(releaseFile, "go");
    await waitForExecScope(sessionKey);
    expect(getFinishedSession(sessionId)?.exitCode).toBe(7);
    expect(enqueueSessionEvent).toHaveBeenCalledTimes(child ? 0 : 1);
    if (!child) {
      const receipt = vi.mocked(enqueueSessionEvent).mock.results[0]!.value;
      await expect(receipt.settled).resolves.toMatchObject({
        status: "completed",
        executionStarted: true,
        delivered: !silentDelivery,
      });
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock.mock.calls[0]?.[0].ctx.SessionKey).toBe(eventSessionKey ?? sessionKey);
      if (restrictedTools) {
        const target = vi.mocked(enqueueSessionEvent).mock.calls[0]?.[1].expectedTarget;
        expect(target).toMatchObject({
          sessionKey: "agent:main:main",
          sessionId: "main-fixture",
        });
        expect(target?.toolsAllow?.toSorted()).toEqual(["exec", "process"]);
        const continuation = dispatchMock.mock.calls[0]![0];
        const tools = await createOpenClawCodingToolsAsync({
          ...toolOptions,
          sessionId: "main-fixture",
          sessionKey: "agent:main:main",
          runSessionKey: "agent:main:main",
          runtimeToolAllowlist: continuation.replyOptions?.toolsAllow,
        });
        expect(tools.map((tool) => tool.name).toSorted()).toEqual(["exec", "process"]);
      }
      // The next execution must retain the restriction for commands it starts.
      expect(dispatchMock.mock.calls[0]?.[0].replyOptions?.internalEventExecution?.deliver).toBe(
        silentDelivery ? false : undefined,
      );
      expect(sendTextMock).toHaveBeenCalledTimes(silentDelivery ? 0 : 1);
    } else {
      expect(dispatchMock).not.toHaveBeenCalled();
      expect(sendTextMock).not.toHaveBeenCalled();
    }
    if (child) {
      const result = await processTool.execute("poll-child", { action: "poll", sessionId });
      expect(result.details).toMatchObject({ status: "completed", exitCode: 7 });
      expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
      acknowledgeInternalToolResult(result);
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    }
  },
);
