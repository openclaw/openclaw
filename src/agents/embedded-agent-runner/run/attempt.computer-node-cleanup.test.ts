// The provider and wire are fixed external I/O. Admission, Stop, attempt cleanup,
// Gateway dispatch, node.invoke, and the registered provider execution owner are real.
// This does not exercise a browser, the Swift app, macOS permissions, or native input.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import { captureRuntimeConfigAsyncReader } from "../../../config/io.runtime.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../../gateway/agent-runtime-approval-authority.js";
import { abortChatRunById, registerChatAbortController } from "../../../gateway/chat-abort.js";
import { createComputerRegistry } from "../../../gateway/desktop/computer-registry.test-support.js";
import { computerCapabilities } from "../../../gateway/desktop/computer.test-support.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../../../gateway/methods/registry.js";
import { NodeRegistry } from "../../../gateway/node-registry.js";
import { createTestNodeSocket, makeClient } from "../../../gateway/node-registry.test-helpers.js";
import { createChatRunState } from "../../../gateway/server-chat-state.js";
import { handleNodeInvokeResult } from "../../../gateway/server-methods/nodes.handlers.invoke-result.js";
import { nodeInvokeHandlers } from "../../../gateway/server-methods/nodes.invoke.js";
import { nodeReadHandlers } from "../../../gateway/server-methods/nodes.read.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import type { GatewayWsClient } from "../../../gateway/server/ws-types.js";
import { approveDevicePairing } from "../../../infra/device-pairing-approval.js";
import {
  isPairedDeviceNodeBindingCurrent,
  resolveCurrentPairedDeviceNodeBinding,
} from "../../../infra/device-pairing-node-state.js";
import { approveNodePairing, requestNodePairing } from "../../../infra/device-pairing-node.js";
import { requestDevicePairing } from "../../../infra/device-pairing.js";
import { createNodeInvokeResponder, type NodeHostClient } from "../../../node-host/client.js";
import type { NodeInvokeRequestPayload } from "../../../node-host/invoke-types.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-context-binding.js";
import { withPluginRuntimeGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../harness/tool-authority.runtime.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createComputerTool } from "../../tools/computer-tool.js";
import { useContextEngineAttemptHarness } from "./attempt-context-engine.test-support.js";
import { withPreparedEmbeddedGatewayTools } from "./attempt-gateway-tools.js";

const { hoisted, runAttempt } = useContextEngineAttemptHarness("agent:main:computer-cleanup");
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

async function createPairedComputerFixture(config: OpenClawConfig) {
  const nodeId = "computer-cleanup-node";
  const connId = "computer-cleanup-connection";
  const caps = ["screen", "computer"];
  const names = ["screen.snapshot", "computer.act"];
  const capabilities = computerCapabilities({
    id: "fixture",
    label: "Fixed desktop I/O",
    generation: "fixture-generation",
  });
  const opened: string[] = [];
  const closed: string[] = [];
  const receivedCloses: string[] = [];
  const receivedActions: string[] = [];
  // Keep this node's provider registry separate from the Gateway plugin registry.
  const registry = createComputerRegistry({
    id: "fixture",
    label: "Fixed desktop I/O",
    isAvailable: () => true,
    capabilities: () => capabilities,
    openExecution: async ({ executionId }) => {
      opened.push(executionId);
      return {
        snapshot: async () =>
          JSON.stringify({ format: "png", base64: png, displayFrameId: "fixture-frame" }),
        act: async () => JSON.stringify({ ok: true }),
        close: async () => {
          closed.push(executionId);
        },
      };
    },
  });
  const commands = new Map(
    registry.nodeHostCommands.map(({ command }) => [command.command, command]),
  );
  const device = await requestDevicePairing({
    deviceId: nodeId,
    publicKey: "public-key",
    role: "node",
    roles: ["node"],
    scopes: [],
  });
  expect(await approveDevicePairing(device.request.requestId, { callerScopes: [] })).toBeTruthy();
  const surface = await requestNodePairing({
    nodeId,
    platform: "macos",
    deviceFamily: "Mac",
    caps,
    commands: names,
  });
  const approval = await approveNodePairing(surface.request.requestId, {
    callerScopes: ["operator.pairing", "operator.admin"],
  });
  expect(approval).toMatchObject({
    requestId: surface.request.requestId,
    node: { nodeId, commands: names },
  });
  const binding = expectDefined(await resolveCurrentPairedDeviceNodeBinding(nodeId), "paired node");
  expect(binding.generation).toBeDefined();
  const nodeRegistry = new NodeRegistry({
    getConfig: () => config,
    resolveCurrentPairingState: resolveCurrentPairedDeviceNodeBinding,
    isPairingStateCurrent: isPairedDeviceNodeBindingCurrent,
  });
  const socket = createTestNodeSocket();
  const client = makeClient(connId, nodeId, [], {
    platform: "darwin",
    caps,
    commands: names,
    computerUse: capabilities,
    socket: socket as unknown as GatewayWsClient["socket"],
  });
  const pending = new Set<Promise<void>>();
  const controllers = new Map<string, AbortController>();
  const errors: unknown[] = [];
  const nodeClient: NodeHostClient = {
    request: async <T>(method: string, params?: unknown): Promise<T> => {
      expect(method).toBe("node.invoke.result");
      if (!isRecord(params)) {
        throw new Error("Node result must be a request object");
      }
      let result: unknown;
      await handleNodeInvokeResult({
        params,
        client,
        context: { nodeRegistry } as GatewayRequestContext,
        req: { type: "req", id: "fixture-result", method },
        isWebchatConnect: () => false,
        respond: (ok, payload, error) => {
          if (!ok) {
            throw new Error(error?.message);
          }
          result = payload;
        },
      });
      return result as T;
    },
  };
  socket.send.mockImplementation((raw) => {
    const event = JSON.parse(raw.toString());
    if (event.event === "node.invoke.cancel") {
      controllers.get(event.payload.invokeId)?.abort();
      return;
    }
    if (event.event !== "node.invoke.request") {
      return;
    }
    const frame = event.payload as NodeInvokeRequestPayload;
    const commandParams: unknown = JSON.parse(frame.paramsJSON ?? "{}");
    if (
      frame.command === "computer.act" &&
      isRecord(commandParams) &&
      commandParams.action === "__close_execution" &&
      typeof commandParams.executionId === "string"
    ) {
      receivedCloses.push(commandParams.executionId);
    } else {
      receivedActions.push(frame.command);
    }
    const controller = new AbortController();
    controllers.set(frame.id, controller);
    const task = (async () => {
      const response = createNodeInvokeResponder(nodeClient, frame);
      try {
        const command = expectDefined(commands.get(frame.command), frame.command);
        const payloadJSON = await command.handle(frame.paramsJSON ?? undefined, undefined, {
          signal: controller.signal,
          sessionKey: frame.sessionKey ?? undefined,
          sendNodeEvent: async () => {
            throw new Error("Unexpected fixture node event");
          },
        });
        await response.send({ ok: true, payloadJSON });
      } catch (error) {
        await response.invalid(error);
      }
    })();
    pending.add(task);
    void task.then(
      () => {
        pending.delete(task);
        controllers.delete(frame.id);
      },
      (error: unknown) => {
        pending.delete(task);
        controllers.delete(frame.id);
        errors.push(error);
      },
    );
  });
  nodeRegistry.register(client, {
    pairingIdentity: binding.identity,
    pairingGeneration: binding.generation,
    approvedSurface: { caps, commands: names },
  });
  const context = createContext([], () => config);
  context.nodeRegistry = nodeRegistry;
  context.validateAgentRuntimeApprovalAuthority = createAgentRuntimeApprovalAuthorityValidator();
  const methods = createGatewayMethodRegistry(
    createCoreGatewayMethodDescriptors({
      "node.list": nodeReadHandlers["node.list"]!,
      "node.invoke": nodeInvokeHandlers["node.invoke"]!,
    }),
  );
  context.getGatewayMethodRegistry = () => methods;
  const resolveGatewayContext = () => context;
  context.resolveGatewayContext = resolveGatewayContext;
  return {
    nodeId,
    context,
    resolveGatewayContext,
    opened,
    closed,
    receivedCloses,
    receivedActions,
    errors,
    async close() {
      await Promise.allSettled(pending);
      await commands.get("screen.snapshot")?.onDisconnect?.();
      nodeRegistry.unregister(connId);
    },
  };
}

type ComputerFixture = Awaited<ReturnType<typeof createPairedComputerFixture>>;
async function startComputerAttempt(
  state: OpenClawTestState,
  computer: ComputerFixture,
  config: OpenClawConfig,
  sessionKey: string,
) {
  const runId = randomUUID();
  const sessionId = "embedded-session";
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const operationalRunInstance = createOperationalRunInstanceRef(runId);
  const registration = withPluginRuntimeGatewayContextResolver(computer.resolveGatewayContext, () =>
    registerChatAbortController({
      runId,
      sessionId,
      sessionKey,
      agentId: "main",
      operationalRunInstance,
      timeoutMs: 60_000,
      target: captureSessionTarget({
        storeScope: storePath,
        sessionKey,
        incarnation: sessionId,
        agentId: "main",
      }),
    }),
  );
  onTestFinished(registration.cleanup);
  const entry = expectDefined(registration.entry, "registered chat source");
  const admission = prepareAgentRunAdmission({
    cfg: config,
    operationalRunInstance,
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", state: "present", boundary: "computer-cleanup-proof" },
    },
    onAdmitted: (admitted) => bindGatewayContextResolver(admitted, computer.resolveGatewayContext),
  });
  onTestFinished(admission.close);
  const admittedRunContext = await admission.admit("embedded");
  registration.bindAgentRunDelegatedAuthority(
    expectDefined(getAdmittedRunDelegatedAuthority(admittedRunContext), "delegated run authority"),
  );
  const observed = createDeferred();
  // Retain the original transport rejection if screenshot setup fails.
  void observed.promise.catch(() => {});
  const afterStop = createDeferred<unknown>();
  void afterStop.promise.catch(() => {});
  const release = createDeferred();
  const onAbort = () => release.resolve();
  entry.input.abortSignal.addEventListener("abort", onAbort, { once: true });
  const model = makeProviderModelFixture({
    id: "fixture-claude",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://example.invalid",
    input: ["text", "image"],
    contextWindow: 8192,
  });
  const attempt = {
    runId,
    sessionId,
    sessionKey,
    agentId: "main",
    agentHarnessId: "openclaw",
    config,
    sessionFile: path.join(state.sessionsDir(), "computer-cleanup.jsonl"),
    sessionTarget: { storePath, sessionKey, sessionId, agentId: "main" },
    workspaceDir: state.workspaceDir,
    agentDir: state.agentDir(),
    provider: model.provider,
    modelId: model.id,
    model,
    sandboxSessionKey: sessionKey,
    senderIsOwner: true,
    messageProvider: "webchat",
    traceAuthorized: false,
    disableTools: false,
    toolsAllow: ["computer"],
    contextTokenBudget: 8192,
  };
  const pending = withPluginRuntimeGatewayContextResolver(computer.resolveGatewayContext, () =>
    withSessionTurn(
      {
        sessionKey,
        sessionId,
        agentId: "main",
        storePath,
        controllerInput: entry.input,
        abortSignal: entry.input.abortSignal,
      },
      (replyOperation, abortSignal) =>
        withPreparedEmbeddedGatewayTools({ ...attempt, admittedRunContext }, () =>
          withPreparedEmbeddedRunToolAuthority(
            { admittedRunContext, replyOperation },
            { ...attempt, abortSignal },
            undefined,
            (prepared) =>
              runAttempt({
                sessionKey,
                attemptOverrides: { ...prepared, admittedRunContext },
                sessionPrompt: async (session) => {
                  try {
                    const tool = expectDefined(
                      session.agent.state.tools.find((candidate) => candidate.name === "computer"),
                      "prepared computer tool",
                    );
                    const result = await tool.execute(
                      "observe",
                      { action: "screenshot", target: "node", node: computer.nodeId },
                      abortSignal,
                    );
                    expect(result.content.some((content) => content.type === "image")).toBe(true);
                    observed.resolve();
                    await release.promise;
                    if (abortSignal?.aborted) {
                      // Reuse the bound tool before disposal, without an aborted input signal.
                      try {
                        afterStop.resolve(
                          await tool.execute("retained-observe", { action: "screenshot" }),
                        );
                      } catch (error) {
                        afterStop.reject(error);
                      }
                    }
                  } catch (error) {
                    observed.reject(error);
                    throw error;
                  }
                },
              }),
          ),
        ),
    ),
  ).finally(() => {
    entry.input.abortSignal.removeEventListener("abort", onAbort);
    registration.cleanup();
    admission.close();
  });
  void pending.catch(() => {});
  return {
    pending,
    observed: observed.promise,
    afterStop: afterStop.promise,
    release: () => release.resolve(),
    signal: entry.input.abortSignal,
    stop: () =>
      abortChatRunById(
        {
          chatRunState: createChatRunState(),
          removeChatRun: () => undefined,
          agentRunSeq: new Map(),
          broadcast: () => {},
          nodeSendToSession: () => {},
          resolveGatewayContext: computer.resolveGatewayContext,
        },
        { runId, sessionKey, stopReason: "user" },
      ),
  };
}

it.for(["completion", "abort"] as const)(
  "releases the paired computer for a successor after %s",
  async (ending, { signal }) => {
    const state = await createOpenClawTestState({ label: "computer-node-cleanup", applyEnv: true });
    onTestFinished(state.cleanup);
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      session: { store: path.join(state.sessionsDir(), "sessions.json") },
      tools: { codeMode: false, toolSearch: false },
      gateway: { nodes: { commands: { allow: ["screen.snapshot", "computer.act"] } } },
    };
    await state.writeConfig(config);
    await captureRuntimeConfigAsyncReader()();
    const computer = await createPairedComputerFixture(config);
    // Replace only unrelated tool assembly; preserve the attempt's real cleanup registrar.
    hoisted.createOpenClawCodingToolsMock.mockImplementation((options) => [
      createComputerTool({
        config: options?.config,
        registerRunCleanup: options?.registerRunCleanup,
        idempotencyScope: options?.runId,
        contextEpoch: options?.computerContextEpoch,
      }),
    ]);
    const sessionKey = `agent:main:computer-cleanup:${randomUUID()}`;
    const runs: Array<Awaited<ReturnType<typeof startComputerAttempt>>> = [];
    try {
      const first = await startComputerAttempt(state, computer, config, sessionKey);
      runs.push(first);
      await withinTest(
        awaitGateBeforeSettlement(
          first.observed,
          first.pending,
          "Attempt ended before acquiring the paired computer",
        ),
        signal,
      );
      expect(computer.opened).toHaveLength(1);
      if (ending === "abort") {
        expect(first.stop()).toEqual({ aborted: true });
        expect(first.signal.aborted).toBe(true);
        await expect(withinTest(first.afterStop, signal)).rejects.toMatchObject({
          name: "AbortError",
          message: "Aborted",
        });
        expect(computer.receivedActions).toEqual(["screen.snapshot"]);
      } else {
        first.release();
      }
      await withinTest(first.pending, signal);
      expect(computer.receivedCloses).toEqual(computer.opened);
      expect(computer.closed).toEqual(computer.opened);

      const successor = await startComputerAttempt(state, computer, config, sessionKey);
      runs.push(successor);
      successor.release();
      // The same node owner would reject the successor with COMPUTER_HOST_BUSY if leaked.
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            successor.observed,
            successor.pending,
            "Successor ended before capturing the paired computer",
          ),
          signal,
        );
      } catch (error) {
        throw new Error(
          `Successor capture failed after ${ending}: ${String(error)}; cleanup=${JSON.stringify({
            receivedByNode: computer.receivedCloses,
            providerClosed: computer.closed,
          })}`,
          { cause: error },
        );
      }
      await withinTest(successor.pending, signal);
      expect(computer.opened).toHaveLength(2);
      expect(new Set(computer.opened).size).toBe(2);
      expect(computer.receivedCloses).toEqual(computer.opened);
      expect(computer.closed).toEqual(computer.opened);
      expect(computer.receivedActions).toEqual(["screen.snapshot", "screen.snapshot"]);
      expect(computer.errors).toEqual([]);
    } finally {
      for (const run of runs) {
        run.release();
      }
      await Promise.allSettled(runs.map((run) => run.pending));
      await computer.close();
    }
  },
);
