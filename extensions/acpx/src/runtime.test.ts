// ACPX tests cover runtime plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RequestedModelUnsupportedError, type AcpxRuntime as UpstreamRuntime } from "acpx/runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcpRuntimeError,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeTurn,
  type AcpRuntimeTurnResult,
} from "../runtime-api.js";
import { OPENCLAW_CODEX_CONFIG_ARG } from "./codex-adapter.js";
import {
  isClaudeAcpCommand,
  renderAgentCommand,
  splitCommandParts,
  type AcpxAgentCommand,
} from "./command-line.js";
import { OPENCLAW_ACPX_LEASE_ID_ARG, OPENCLAW_GATEWAY_INSTANCE_ID_ARG } from "./process-lease.js";
import type { AcpxRuntime } from "./runtime.js";
import {
  CODEX_ACP_WRAPPER_COMMAND,
  makeEmptySessionStore,
  makeLeasedRuntime,
  makeLeaseStore,
  makeRuntime,
  makeTurn,
  observeLaunch,
  runtimeCommand,
  type TestSessionStore,
} from "./runtime.test-support.js";

const DOCUMENTED_OPENCLAW_BRIDGE_COMMAND =
  "env OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 openclaw acp --url ws://127.0.0.1:18789 --token-file ~/.openclaw/gateway.token --session agent:main:main";
const CODEX_ACP_COMMAND = "npx @agentclientprotocol/codex-acp@1.11.0";
const LOCAL_NODE_MODULES_CODEX_COMMAND = `node "${path.resolve(
  "node_modules/@agentclientprotocol/codex-acp/dist/index.js",
)}"`;

function recordCommand(command: AcpxAgentCommand) {
  return {
    agentCommand: renderAgentCommand(command),
    ...(typeof command === "string" ? {} : { agentArgv: command }),
  };
}

function makeAgentRuntime(agent: string, command: AcpxAgentCommand) {
  const { runtime, delegate } = makeRuntime(makeEmptySessionStore(), {
    agentRegistry: { resolve: () => command, list: () => [agent] },
  });
  const ensure = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
    sessionKey: `agent:${agent}:acp:test`,
    backend: "acpx",
    runtimeSessionName: agent,
  });
  return { runtime, ensure };
}

function makeControlRuntime(agent: string, command: AcpxAgentCommand) {
  const handle = {
    sessionKey: `agent:${agent}:acp:test`,
    backend: "acpx",
    runtimeSessionName: `agent:${agent}:acp:test`,
    acpxRecordId: `agent:${agent}:acp:test`,
  };
  const { runtime, delegate } = makeRuntime({
    load: vi.fn(async () => ({ acpxRecordId: handle.acpxRecordId, agentCommand: command })),
    save: vi.fn(async () => {}),
  });
  return { runtime, delegate, handle };
}

function seedLease(
  leases: ReturnType<typeof makeLeaseStore>,
  leaseId: string,
  rootPid: number,
  startedAt: number,
) {
  leases.leases.set(leaseId, {
    leaseId,
    gatewayInstanceId: "gateway-test",
    sessionKey: "agent:codex:acp:binding:test",
    wrapperRoot: "/tmp/openclaw/acpx",
    wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
    rootPid,
    commandHash: "hash",
    startedAt,
    state: "open",
  });
}

function readFirstEnsureSessionInput(ensure: {
  mock: { calls: Array<Array<unknown>> };
}): Parameters<AcpRuntime["ensureSession"]>[0] {
  const [call] = ensure.mock.calls;
  if (!call) {
    throw new Error("Expected ensureSession to be called");
  }
  const [input] = call;
  if (typeof input !== "object" || input === null) {
    throw new Error("Expected ensureSession to be called with an input object");
  }
  return input as Parameters<AcpRuntime["ensureSession"]>[0];
}

describe("AcpxRuntime fresh reset wrapper", () => {
  it("projects only core controls while retaining upstream capability metadata", async () => {
    const { runtime, delegate } = makeRuntime(makeEmptySessionStore());
    const capabilities: Awaited<ReturnType<UpstreamRuntime["getCapabilities"]>> = {
      controls: [
        "session/set_mode",
        "session/set_model",
        "session/set_config_option",
        "session/status",
      ],
      configOptionKeys: ["model", "effort"],
    };
    const getCapabilities = vi.spyOn(delegate, "getCapabilities").mockResolvedValue(capabilities);
    const handle = {
      sessionKey: "agent:main:acp:test",
      backend: "acpx",
      runtimeSessionName: "agent:main:acp:test",
    };
    expect(await runtime.getCapabilities({ handle })).toEqual({
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
      configOptionKeys: ["model", "effort"],
    });
    expect(capabilities.controls).toContain("session/set_model");
    expect(getCapabilities).toHaveBeenCalledExactlyOnceWith({ handle });
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects unsupported runtime session modes with a clear AcpRuntimeError (issue #73071)", async () => {
    const baseStore: TestSessionStore = makeEmptySessionStore();
    const { runtime, delegate } = makeRuntime(baseStore);
    const ensureSpy = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:claude:acp:test",
      backend: "acpx",
      runtimeSessionName: "claude",
    });

    for (const badMode of ["run", "session", "", undefined, null, 0]) {
      let error: unknown;
      try {
        await runtime.ensureSession({
          sessionKey: "agent:claude:acp:test",
          agent: "claude",
          mode: badMode as never,
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(AcpRuntimeError);
      const acpError = error as AcpRuntimeError;
      expect(acpError.name).toBe("AcpRuntimeError");
      expect(acpError.code).toBe("ACP_INVALID_RUNTIME_OPTION");
      expect(acpError.message).toBe(
        `Unsupported ACP runtime session mode ${JSON.stringify(badMode)}. Expected one of: persistent, oneshot.`,
      );
    }

    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it("advertises elicitation modes and forwards the exact elicitation handler for plain and managed sessions", async () => {
    const onElicitation = vi.fn(async () => ({ action: "cancel" as const }));
    const handle = (sessionKey: string) => ({
      sessionKey,
      backend: "acpx",
      runtimeSessionName: sessionKey,
      acpxRecordId: sessionKey,
    });
    const runThrough = async (runtime: AcpxRuntime, sessionKey: string) => {
      await runtime.startTurn({
        handle: handle(sessionKey),
        text: "ask",
        mode: "prompt",
        requestId: `request:${sessionKey}`,
        onElicitation,
      }).result;
    };
    const baseStore = (agentCommand: string): TestSessionStore => ({
      load: vi.fn(async (sessionId: string) => ({ acpxRecordId: sessionId, agentCommand })),
      save: vi.fn(async () => {}),
    });

    const defaultRuntime = makeRuntime(baseStore(CODEX_ACP_COMMAND), {
      elicitationModes: ["form", "url"],
    });
    const defaultTurn = vi.spyOn(defaultRuntime.delegate, "startTurn").mockImplementation(makeTurn);
    await runThrough(defaultRuntime.runtime, "agent:codex:acp:default");

    const bridgeRuntime = makeRuntime(baseStore(DOCUMENTED_OPENCLAW_BRIDGE_COMMAND), {
      elicitationModes: ["form", "url"],
      mcpServers: [{ name: "tools", command: "mcp-tools" }] as never,
    });
    const bridgeDelegate = bridgeRuntime.delegate;
    const bridgeTurn = vi.spyOn(bridgeDelegate, "startTurn").mockImplementation(makeTurn);
    await runThrough(bridgeRuntime.runtime, "agent:openclaw:acp:bridge");

    const managedRuntime = makeRuntime(baseStore(CODEX_ACP_COMMAND), {
      elicitationModes: ["form", "url"],
      openclawToolsMcpBridgeEnabled: true,
      mcpServers: [{ name: "openclaw-tools", command: "node", args: [], env: [] }],
    });
    const managedDelegate = managedRuntime.delegate;
    const managedTurn = vi.spyOn(managedDelegate, "startTurn").mockImplementation(makeTurn);
    await runThrough(managedRuntime.runtime, "agent:codex:acp:managed");

    for (const turn of [defaultTurn, bridgeTurn, managedTurn]) {
      expect(turn).toHaveBeenCalledOnce();
      expect(turn.mock.calls[0]?.[0].onElicitation).toBe(onElicitation);
    }
    for (const delegate of [defaultRuntime.delegate, bridgeDelegate, managedDelegate] as Array<{
      options?: { elicitationModes?: readonly string[] };
    }>) {
      expect(delegate.options?.elicitationModes).toEqual(["form", "url"]);
    }
  });

  it.each([
    { model: "gpt-5.4", controls: {} },
    { model: "gpt-5.5", controls: {} },
    { model: "gpt-5.6-sol", controls: { thinking: "medium" } },
  ] as const)(
    "normalizes Codex startup $model and keeps thinking separate",
    async ({ model, controls }) => {
      const { runtime, ensure } = makeAgentRuntime("codex", CODEX_ACP_COMMAND);

      await runtime.ensureSession({
        sessionKey: "agent:codex:acp:test",
        agent: "codex",
        mode: "persistent",
        model: `openai/${model}`,
        ...controls,
      });

      expect(readFirstEnsureSessionInput(ensure)).toEqual({
        sessionKey: "agent:codex:acp:test",
        agent: "codex",
        mode: "persistent",
        model,
        ...controls,
        sessionOptions: { model },
      });
    },
  );

  it.each([
    {
      name: "strips the OpenClaw Anthropic provider prefix for Claude ACP startup",
      model: "anthropic/claude-sonnet-4-6",
      expectedModel: "claude-sonnet-4-6",
    },
    {
      name: "preserves custom Claude ACP startup models",
      model: "custom-model",
      expectedModel: "custom-model",
    },
    {
      // Issue #121034: Bedrock rejects provider-qualified refs.
      name: "strips the OpenClaw Bedrock provider prefix for Claude ACP startup",
      model: "amazon-bedrock/global.anthropic.claude-sonnet-5",
      expectedModel: "global.anthropic.claude-sonnet-5",
    },
    {
      name: "matches the Bedrock provider prefix case-insensitively",
      model: "Amazon-Bedrock/us.anthropic.claude-opus-4-6-v1",
      expectedModel: "us.anthropic.claude-opus-4-6-v1",
    },
    {
      // Bare inference-profile ids and ARNs are native Bedrock values the SDK
      // accepts as-is; only the documented OpenClaw prefixes may be stripped.
      name: "preserves native Bedrock inference-profile ids",
      model: "global.anthropic.claude-sonnet-5",
      expectedModel: "global.anthropic.claude-sonnet-5",
    },
    {
      name: "preserves Bedrock inference-profile ARNs",
      model:
        "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-5",
      expectedModel:
        "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-5",
    },
  ])("$name", async ({ model, expectedModel }) => {
    const baseStore: TestSessionStore = makeEmptySessionStore();
    const { runtime, delegate } = makeRuntime(baseStore, {
      agentRegistry: {
        resolve: (agentName: string) =>
          agentName === "claude" ? "npx @agentclientprotocol/claude-agent-acp" : agentName,
        list: () => ["claude", "openclaw"],
      },
    });
    const ensure = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:claude:acp:test",
      backend: "acpx",
      runtimeSessionName: "claude",
    });

    await runtime.ensureSession({
      sessionKey: "agent:claude:acp:test",
      agent: "claude",
      mode: "persistent",
      model,
    });

    expect(readFirstEnsureSessionInput(ensure)).toEqual({
      sessionKey: "agent:claude:acp:test",
      agent: "claude",
      mode: "persistent",
      model: expectedModel,
      sessionOptions: { model: expectedModel },
    });
  });

  it("leaves Codex ACP startup defaults alone when no model or thinking is provided", async () => {
    const { runtime, ensure } = makeAgentRuntime("codex", CODEX_ACP_COMMAND);

    await runtime.ensureSession({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
    });

    const ensureInput = readFirstEnsureSessionInput(ensure);
    expect(ensureInput).toEqual({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
    });
    expect(ensureInput).not.toHaveProperty("model");
    expect(ensureInput).not.toHaveProperty("thinking");
  });

  it.each([
    {
      name: "adds the redacted Codex wrapper stderr tail to session initialization failures",
      stderr:
        "noise\nUnhandled error during session/new: deployment missing token=[REDACTED] sk-testsecret1234567890\n",
      expectedFragment: "deployment missing",
      forbiddenFragment: "sk-testsecret1234567890",
    },
    {
      name: "keeps the 6,000-unit Codex wrapper stderr tail UTF-16 safe",
      stderr: `🚀${"a".repeat(5_999)}`,
      expectedFragment: `Internal error: ${"a".repeat(5_999)}`,
      forbiddenFragment: "\ude80",
    },
  ])("$name", async ({ stderr, expectedFragment, forbiddenFragment }) => {
    const wrapperRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-runtime-"));
    const leaseStore = makeLeaseStore();
    const wrapperCommand = `node "${path.join(wrapperRoot, "codex-acp-wrapper.mjs")}"`;
    const baseStore: TestSessionStore = makeEmptySessionStore();
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: wrapperRoot,
      agentRegistry: {
        resolve: (agentName: string) => (agentName === "codex" ? wrapperCommand : agentName),
        list: () => ["codex"],
      },
    });
    vi.spyOn(delegate, "ensureSession").mockImplementation(async () => {
      await observeLaunch(runtime, { sessionKey: "agent:codex:acp:test" });
      const leaseId = String(Array.from(leaseStore.leases.values())[0]?.leaseId);
      await fs.writeFile(
        path.join(wrapperRoot, `codex-acp-wrapper.stderr.${leaseId}.log`),
        stderr,
        "utf8",
      );
      throw new Error("Internal error");
    });

    const outcome = await runtime
      .ensureSession({
        sessionKey: "agent:codex:acp:test",
        agent: "codex",
        mode: "oneshot",
      })
      .then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") {
      return;
    }
    expect(outcome.error).toMatchObject({
      name: "AcpRuntimeError",
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining(expectedFragment),
    });
    const error = outcome.error;
    expect(error).toBeInstanceOf(AcpRuntimeError);
    if (!(error instanceof AcpRuntimeError)) {
      throw new Error("expected AcpRuntimeError");
    }
    expect(error.message).not.toContain(forbiddenFragment);
  });

  it("adds Codex wrapper stderr tail to generic startTurn failure results", async () => {
    const promptStarted = createDeferred<void>();
    const wrapperRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-runtime-"));
    await fs.writeFile(
      path.join(wrapperRoot, "codex-acp-wrapper.stderr.lease-start-turn.log"),
      "Unhandled error during turn: adapter disconnected after progress\n",
      "utf8",
    );
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:test",
        agentCommand: CODEX_ACP_WRAPPER_COMMAND,
        openclawLeaseId: "lease-start-turn",
      })),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawWrapperRoot: wrapperRoot,
      agentRegistry: {
        resolve: (agentName: string) =>
          agentName === "codex" ? CODEX_ACP_WRAPPER_COMMAND : agentName,
        list: () => ["codex"],
      },
    });
    vi.spyOn(delegate, "startTurn").mockImplementation((input): AcpRuntimeTurn => {
      return {
        requestId: input.requestId,
        promptStarted: promptStarted.promise,
        events: (async function* () {
          yield {
            type: "text_delta" as const,
            stream: "output" as const,
            text: "Vou mapear o fluxo real primeiro...",
          };
        })(),
        result: Promise.resolve({
          status: "failed" as const,
          error: {
            message: "Internal error",
            retryable: false,
          },
        }),
        cancel: vi.fn(async () => {}),
        closeStream: vi.fn(async () => {}),
      };
    });

    const turn = runtime.startTurn({
      handle: {
        sessionKey: "agent:codex:acp:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:test",
        acpxRecordId: "agent:codex:acp:test",
      },
      text: "Reply exactly OK",
      mode: "prompt",
      requestId: "turn-1",
    });
    expect(turn.promptStarted).toBeDefined();
    let submitted = false;
    const observedPromptStarted = turn.promptStarted.then(() => {
      submitted = true;
    });
    const events: AcpRuntimeEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
    }
    expect(submitted).toBe(false);
    promptStarted.resolve();
    await observedPromptStarted;
    expect(submitted).toBe(true);

    await expect(turn.result).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "ACP_TURN_FAILED",
        message: expect.stringContaining("adapter disconnected after progress"),
        retryable: false,
      },
    });
    expect(events).toEqual([
      {
        type: "text_delta",
        stream: "output",
        text: "Vou mapear o fluxo real primeiro...",
      },
    ]);
  });

  it.each(["creation", "events", "result"] as const)(
    "adds Codex wrapper stderr tail when startTurn %s throws",
    async (failureBoundary) => {
      const wrapperRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-runtime-"));
      await fs.writeFile(
        path.join(wrapperRoot, "codex-acp-wrapper.stderr.lease-start-turn-create.log"),
        "Unhandled error during turn: adapter failed before returning turn\n",
        "utf8",
      );
      const baseStore: TestSessionStore = {
        load: vi.fn(async () => ({
          acpxRecordId: "agent:codex:acp:test",
          agentCommand: CODEX_ACP_WRAPPER_COMMAND,
          openclawLeaseId: "lease-start-turn-create",
        })),
        save: vi.fn(async () => {}),
      };
      const { runtime, delegate } = makeRuntime(baseStore, {
        openclawWrapperRoot: wrapperRoot,
        agentRegistry: {
          resolve: (agentName: string) =>
            agentName === "codex" ? CODEX_ACP_WRAPPER_COMMAND : agentName,
          list: () => ["codex"],
        },
      });
      vi.spyOn(delegate, "startTurn").mockImplementation((input) => {
        if (failureBoundary === "creation") {
          throw new Error("Internal error");
        }
        return makeTurn(
          input,
          failureBoundary === "events"
            ? {
                events: (async function* () {
                  yield { type: "status" as const, text: "Connecting" };
                  throw new Error("Internal error");
                })(),
              }
            : { result: Promise.reject(new Error("Internal error")) },
        );
      });

      const turn = runtime.startTurn({
        handle: {
          sessionKey: "agent:codex:acp:test",
          backend: "acpx",
          runtimeSessionName: "agent:codex:acp:test",
          acpxRecordId: "agent:codex:acp:test",
        },
        text: "Reply exactly OK",
        mode: "prompt",
        requestId: "turn-1",
      });

      const failure =
        failureBoundary === "events"
          ? (async () => {
              for await (const event of turn.events) {
                void event;
              }
            })()
          : failureBoundary === "creation"
            ? turn.promptStarted
            : turn.result;
      const expected = {
        name: "AcpRuntimeError",
        code: "ACP_TURN_FAILED",
        message: expect.stringContaining("adapter failed before returning turn"),
      };
      await expect(failure).rejects.toMatchObject(expected);
      if (failureBoundary === "events") {
        await expect(turn.result).resolves.toEqual({ status: "completed" });
      } else {
        await expect(turn.result).rejects.toMatchObject(expected);
      }
    },
  );

  it.each([
    {
      result: { status: "completed", stopReason: "end_turn" },
      event: { type: "done", stopReason: "end_turn" },
    },
    {
      result: { status: "cancelled", stopReason: "cancelled" },
      event: { type: "done", stopReason: "cancelled" },
    },
    {
      result: {
        status: "failed",
        error: {
          code: "ACP_TURN_FAILED",
          detailCode: "PROVIDER_ERROR",
          message: "Provider failed",
          retryable: false,
        },
      },
      event: {
        type: "error",
        code: "ACP_TURN_FAILED",
        detailCode: "PROVIDER_ERROR",
        message: "Provider failed",
        retryable: false,
      },
    },
  ] satisfies Array<{ result: AcpRuntimeTurnResult; event: AcpRuntimeEvent }>)(
    "projects the $result.status result into one legacy runTurn terminal event",
    async ({ result, event }) => {
      const baseStore: TestSessionStore = {
        load: vi.fn(async () => ({ name: "agent:claude:acp:terminal", agentCommand: "claude" })),
        save: vi.fn(async () => {}),
      };
      const { runtime, delegate } = makeRuntime(baseStore);
      const cancel = vi.fn(async () => {});
      vi.spyOn(delegate, "startTurn").mockImplementation((input) =>
        makeTurn(input, {
          events: (async function* () {
            yield { type: "text_delta" as const, text: "Progress" };
          })(),
          result: Promise.resolve(result),
          cancel,
        }),
      );
      const events: AcpRuntimeEvent[] = [];
      for await (const update of runtime.runTurn({
        handle: {
          sessionKey: "agent:claude:acp:terminal",
          backend: "acpx",
          runtimeSessionName: "terminal",
        },
        text: "Do work",
        mode: "prompt",
        requestId: "terminal",
      })) {
        events.push(update);
      }
      expect(events).toEqual([{ type: "text_delta", text: "Progress" }, event]);
      expect(cancel).not.toHaveBeenCalled();
    },
  );

  it("disables delegate prompt timeout for OpenClaw-managed turns", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:test",
        agentCommand: CODEX_ACP_COMMAND,
      })),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore, {
      timeoutMs: 1,
      agentRegistry: {
        resolve: (agentName: string) => (agentName === "codex" ? CODEX_ACP_COMMAND : agentName),
        list: () => ["codex"],
      },
    });
    const startTurn = vi.spyOn(delegate, "startTurn").mockImplementation(makeTurn);

    const turn = runtime.startTurn({
      handle: {
        sessionKey: "agent:codex:acp:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:test",
        acpxRecordId: "agent:codex:acp:test",
      },
      text: "Reply exactly OK",
      mode: "prompt",
      requestId: "turn-2",
    });
    await turn.result;

    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 0,
      }),
    );
  });

  it.each([undefined, true])(
    "handles missing model capability with explicit selection=%s",
    async (modelExplicit) => {
      const baseStore: TestSessionStore = makeEmptySessionStore();
      const { runtime, delegate } = makeRuntime(baseStore, {
        agentRegistry: {
          resolve: (agentName: string) => (agentName === "opencode" ? "opencode acp" : agentName),
          list: () => ["opencode"],
        },
      });
      const ensure = vi
        .spyOn(delegate, "ensureSession")
        .mockRejectedValueOnce(
          new RequestedModelUnsupportedError(
            "Cannot apply --model: the ACP agent did not advertise model support",
            "missing-capability",
          ),
        )
        .mockResolvedValueOnce({
          sessionKey: "agent:opencode:acp:test",
          backend: "acpx",
          runtimeSessionName: "opencode",
        });

      const initialized = runtime.ensureSession({
        sessionKey: "agent:opencode:acp:test",
        agent: "opencode",
        mode: "persistent",
        model: "openrouter/owl-alpha",
        modelExplicit,
      });

      if (modelExplicit) {
        await expect(initialized).rejects.toMatchObject({ reason: "missing-capability" });
        expect(ensure).toHaveBeenCalledOnce();
        return;
      }
      await expect(initialized).resolves.toMatchObject({ appliedModel: { kind: "dropped" } });

      expect(ensure).toHaveBeenCalledTimes(2);
      expect(readFirstEnsureSessionInput(ensure)).toMatchObject({
        model: "openrouter/owl-alpha",
        sessionOptions: { model: "openrouter/owl-alpha" },
      });
      const [, secondCall] = ensure.mock.calls;
      expect(secondCall?.[0]).not.toHaveProperty("sessionOptions");
      expect((secondCall?.[0] as { model?: string } | undefined)?.model).toBeUndefined();
    },
  );

  it("keeps rejecting an unsupported model after retrying its OpenClaw reference", async () => {
    const baseStore: TestSessionStore = makeEmptySessionStore();
    const { runtime, delegate } = makeRuntime(baseStore, {
      agentRegistry: {
        resolve: (agentName: string) => (agentName === "opencode" ? "opencode acp" : agentName),
        list: () => ["opencode"],
      },
    });
    const ensure = vi
      .spyOn(delegate, "ensureSession")
      .mockRejectedValue(
        new RequestedModelUnsupportedError(
          "Cannot apply --model: the ACP agent did not advertise that model",
          "unadvertised-model",
        ),
      );

    await expect(
      runtime.ensureSession({
        sessionKey: "agent:opencode:acp:test",
        agent: "opencode",
        mode: "persistent",
        model: "unknown/model",
      }),
    ).rejects.toThrow("did not advertise that model");
    // Both attempts carry a model; failed startup never publishes a model-less session.
    expect(ensure.mock.calls.map(([input]) => input.model)).toEqual(["unknown/model", "model"]);
  });

  it("does not retry an unrelated error with similar wording", async () => {
    const baseStore: TestSessionStore = makeEmptySessionStore();
    const { runtime, delegate } = makeRuntime(baseStore);
    const ensure = vi
      .spyOn(delegate, "ensureSession")
      .mockRejectedValueOnce(new Error("the ACP agent did not advertise model support"));

    await expect(
      runtime.ensureSession({
        sessionKey: "agent:main:acp:test",
        agent: "main",
        mode: "persistent",
        model: "openrouter/owl-alpha",
      }),
    ).rejects.toThrow("did not advertise model support");
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it.each([
    { thinking: "off", expectedEffort: undefined },
    { thinking: "low", expectedEffort: "low" },
    { thinking: undefined, expectedEffort: "high" },
  ])(
    "honors explicit thinking=$thinking over Codex ACP model suffixes",
    async ({ thinking, expectedEffort }) => {
      const save = vi.fn<TestSessionStore["save"]>(async () => {});
      const baseStore: TestSessionStore = {
        load: vi.fn(async () => undefined),
        save,
      };
      const { runtime, delegate, wrappedStore } = makeRuntime(baseStore, {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: makeLeaseStore().store,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
        agentRegistry: {
          resolve: () => CODEX_ACP_WRAPPER_COMMAND,
          list: () => ["codex"],
        },
      });
      vi.spyOn(delegate, "ensureSession").mockImplementation(async (input) => {
        await wrappedStore.save({ name: input.sessionKey, cwd: "/tmp", pid: 777 });
        return {
          sessionKey: input.sessionKey,
          backend: "acpx",
          runtimeSessionName: input.sessionKey,
        };
      });

      await runtime.ensureSession({
        sessionKey: "agent:codex:acp:test",
        agent: "codex",
        mode: "persistent",
        model: "openai/gpt-5.6-luna/high",
        thinking,
      });

      const [record] = save.mock.calls[0]!;
      const argv = record.agentArgv;
      if (!Array.isArray(argv)) {
        throw new Error("Expected persisted ACP argv");
      }
      expect(argv).toContain(OPENCLAW_CODEX_CONFIG_ARG);
      const configArg: unknown = argv[argv.indexOf(OPENCLAW_CODEX_CONFIG_ARG) + 1];
      if (typeof configArg !== "string") {
        throw new Error("Expected a Codex startup config argument");
      }
      expect(JSON.parse(configArg)).toEqual({
        model: "gpt-5.6-luna",
        ...(expectedEffort ? { model_reasoning_effort: expectedEffort } : {}),
      });
    },
  );

  it.each([
    { command: CODEX_ACP_COMMAND, explicit: false, expected: undefined },
    { command: "custom-acp", explicit: false, expected: "max" },
    { command: CODEX_ACP_COMMAND, explicit: true, expected: undefined },
  ])(
    "resolves inherited and explicit max for $command (explicit=$explicit)",
    async ({ command, explicit, expected }) => {
      const { runtime, ensure } = makeAgentRuntime("codex", command);
      const result = runtime.ensureSession({
        sessionKey: "agent:codex:acp:test",
        agent: "codex",
        mode: "persistent",
        thinking: "max",
        thinkingExplicit: explicit,
      });
      if (explicit) {
        await expect(result).rejects.toMatchObject({ code: "ACP_INVALID_RUNTIME_OPTION" });
        expect(ensure).not.toHaveBeenCalled();
      } else {
        const handle = await result;
        expect(readFirstEnsureSessionInput(ensure)).toEqual({
          sessionKey: "agent:codex:acp:test",
          agent: "codex",
          mode: "persistent",
          ...(expected ? { thinking: expected } : {}),
        });
        expect(handle.appliedThinking).toEqual(expected ? undefined : { kind: "dropped" });
      }
    },
  );

  it.each([
    { model: "google/gemini-3.1-flash-lite", thinking: undefined },
    { model: "google/gemini-3.1-flash-lite", thinking: "low" },
    { model: "gpt-5.4/ultra", thinking: undefined },
  ])("drops inherited $model without losing thinking=$thinking", async ({ model, thinking }) => {
    const { runtime, ensure } = makeAgentRuntime("codex", CODEX_ACP_COMMAND);
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
      model,
      thinking,
    });
    expect(readFirstEnsureSessionInput(ensure)).toEqual({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
      ...(thinking ? { thinking } : {}),
    });
    expect(handle.appliedModel).toEqual({ kind: "dropped" });
  });

  it.each(["google/gemini-3.1-flash-lite", "gpt-5.4/ultra"])(
    "rejects an explicit unsupported model %s before the delegate",
    async (model) => {
      const { runtime, ensure } = makeAgentRuntime("codex", CODEX_ACP_COMMAND);
      await expect(
        runtime.ensureSession({
          sessionKey: "agent:codex:acp:test",
          agent: "codex",
          mode: "persistent",
          model,
          modelExplicit: true,
        }),
      ).rejects.toMatchObject({ code: "ACP_INVALID_RUNTIME_OPTION" });
      expect(ensure).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, true])(
    "reports an applied model without leaking explicit=%s",
    async (modelExplicit) => {
      const { runtime, ensure } = makeAgentRuntime("codex", CODEX_ACP_COMMAND);
      const handle = await runtime.ensureSession({
        sessionKey: "agent:codex:acp:test",
        agent: "codex",
        mode: "persistent",
        model: "openai/gpt-5.5",
        modelExplicit,
      });
      expect(handle.appliedModel).toEqual({ kind: "applied", model: "openai/gpt-5.5" });
      expect(readFirstEnsureSessionInput(ensure)).toEqual({
        sessionKey: "agent:codex:acp:test",
        agent: "codex",
        mode: "persistent",
        model: "gpt-5.5",
        sessionOptions: { model: "gpt-5.5" },
      });
    },
  );

  it.each([
    {
      name: "normalizes OpenClaw-qualified Codex ACP model controls",
      value: "openai/gpt-5.4",
    },
    { name: "passes bare Codex ACP model controls through", value: "gpt-5.4" },
  ])("$name", async ({ value }) => {
    const { runtime, delegate, handle } = makeControlRuntime("codex", CODEX_ACP_COMMAND);
    const accepted = { configOptions: [{ id: "reasoning_effort", currentValue: "medium" }] };
    const setConfigOption = vi.spyOn(delegate, "setConfigOption").mockResolvedValue(accepted);

    const result = await runtime.setConfigOption({
      handle,
      key: "model",
      value,
    });
    expect(result).toBe(accepted);

    expect(setConfigOption).toHaveBeenCalledOnce();
    expect(setConfigOption).toHaveBeenCalledWith({
      handle,
      key: "model",
      value: "gpt-5.4",
    });
  });

  it.each([
    "google/gemini-3.1-flash-lite",
    "gpt-5.4/ultra",
    "openai/foo/bar",
    "openai/",
    "openai//high",
  ])("fails closed on Codex ACP model config control %s without re-injecting it", async (value) => {
    const { runtime, delegate, handle } = makeControlRuntime("codex", CODEX_ACP_COMMAND);
    const setConfigOption = vi.spyOn(delegate, "setConfigOption").mockResolvedValue(undefined);

    await expect(runtime.setConfigOption({ handle, key: "model", value })).rejects.toMatchObject({
      code: "ACP_INVALID_RUNTIME_OPTION",
    });
    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it("normalizes Codex ACP slash reasoning suffixes to config controls", async () => {
    const { runtime, delegate, handle } = makeControlRuntime("codex", CODEX_ACP_COMMAND);
    const accepted = { configOptions: [{ id: "reasoning_effort", currentValue: "high" }] };
    const setConfigOption = vi
      .spyOn(delegate, "setConfigOption")
      .mockResolvedValueOnce({
        configOptions: [{ id: "reasoning_effort", currentValue: "medium" }],
      })
      .mockResolvedValueOnce(accepted);

    const result = await runtime.setConfigOption({
      handle,
      key: "model",
      value: "openai/gpt-5.4/high",
    });
    expect(result).toBe(accepted);

    expect(setConfigOption).toHaveBeenNthCalledWith(1, {
      handle,
      key: "model",
      value: "gpt-5.4",
    });
    expect(setConfigOption).toHaveBeenNthCalledWith(2, {
      handle,
      key: "reasoning_effort",
      value: "high",
    });
  });

  it.each([
    {
      name: "normalizes Codex ACP thinking=minimal to reasoning effort",
      key: "thinking",
      value: "minimal",
      expected: "low",
    },
    {
      name: "normalizes Codex ACP reasoning_effort=x-high",
      key: "reasoning_effort",
      value: "x-high",
      expected: "xhigh",
    },
    {
      name: "rejects unsupported Codex ACP thinking controls",
      key: "thinking",
      value: "superhigh",
    },
    ...["thinking", "thought_level", "reasoning_effort"].map((key) => ({
      name: `rejects unsupported live Codex ACP ${key}=off`,
      key,
      value: "off",
      expected: undefined,
      errorCode: "ACP_BACKEND_UNSUPPORTED_CONTROL",
    })),
  ])("$name", async (testCase) => {
    const { key, value, expected } = testCase;
    const { runtime, delegate, handle } = makeControlRuntime("codex", CODEX_ACP_COMMAND);
    const accepted = {
      configOptions: [{ id: "reasoning_effort", currentValue: expected ?? "medium" }],
    };
    const setConfigOption = vi.spyOn(delegate, "setConfigOption").mockResolvedValue(accepted);

    const update = runtime.setConfigOption({
      handle,
      key,
      value,
    });
    if (!expected) {
      await expect(update).rejects.toMatchObject({
        code: "errorCode" in testCase ? testCase.errorCode : "ACP_INVALID_RUNTIME_OPTION",
      });
      expect(setConfigOption).not.toHaveBeenCalled();
      return;
    }

    await expect(update).resolves.toBe(accepted);
    expect(setConfigOption).toHaveBeenCalledWith({
      handle,
      key: "reasoning_effort",
      value: expected,
    });
  });

  it.each([
    ["codex", CODEX_ACP_COMMAND],
    ["claude", "npx @agentclientprotocol/claude-agent-acp"],
  ])("ignores unsupported %s timeout controls", async (agent, command) => {
    const { runtime, delegate, handle } = makeControlRuntime(agent, command);
    const setConfigOption = vi.spyOn(delegate, "setConfigOption").mockResolvedValue(undefined);
    for (const key of ["timeout", "Timeout_Seconds"]) {
      await runtime.setConfigOption({ handle, key, value: "60" });
    }
    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it("normalizes model config controls for claude-agent-acp", async () => {
    const { runtime, delegate, handle } = makeControlRuntime(
      "claude",
      "npx @agentclientprotocol/claude-agent-acp",
    );
    const accepted = { configOptions: [{ id: "effort", currentValue: "low" }] };
    const setConfigOption = vi.spyOn(delegate, "setConfigOption").mockResolvedValue(accepted);

    const result = await runtime.setConfigOption({
      handle,
      key: "model",
      value: "anthropic/claude-sonnet-4-6",
    });
    expect(result).toBe(accepted);
    await runtime.setConfigOption({
      handle,
      key: "model",
      value: "amazon-bedrock/global.anthropic.claude-sonnet-5",
    });

    expect(setConfigOption).toHaveBeenNthCalledWith(1, {
      handle,
      key: "model",
      value: "claude-sonnet-4-6",
    });
    expect(setConfigOption).toHaveBeenNthCalledWith(2, {
      handle,
      key: "model",
      value: "global.anthropic.claude-sonnet-5",
    });
    expect(setConfigOption).toHaveBeenCalledTimes(2);
  });

  it("recognizes claude-agent-acp commands", () => {
    expect(isClaudeAcpCommand("npx @agentclientprotocol/claude-agent-acp")).toBe(true);
    expect(isClaudeAcpCommand("npx -y @agentclientprotocol/claude-agent-acp@0.33.1")).toBe(true);
    expect(isClaudeAcpCommand("claude-agent-acp")).toBe(true);
    expect(isClaudeAcpCommand("claude-agent-acp.exe")).toBe(true);
    expect(isClaudeAcpCommand(`node "/tmp/openclaw/acpx/claude-agent-acp-wrapper.mjs"`)).toBe(true);
    expect(
      isClaudeAcpCommand(
        `node.exe "C:/Users/runner/AppData/Local/Temp/openclaw/acpx/claude-agent-acp-wrapper.mjs"`,
      ),
    ).toBe(true);
    expect(
      isClaudeAcpCommand(
        `Node.EXE "C:/Users/runner/AppData/Local/Temp/openclaw/acpx/claude-agent-acp-wrapper.mjs"`,
      ),
    ).toBe(true);
    expect(isClaudeAcpCommand("openclaw acp")).toBe(false);
    expect(isClaudeAcpCommand("npx @agentclientprotocol/codex-acp")).toBe(false);
  });

  it("does not create launch leases for direct plugin-local ACP adapter commands", async () => {
    const launchCommands: string[] = [];
    const baseStore: TestSessionStore = makeEmptySessionStore();
    const leaseStore = makeLeaseStore();
    const { runtime, delegate, wrappedStore } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
      agentRegistry: {
        resolve: (agentName: string) =>
          agentName === "codex" ? LOCAL_NODE_MODULES_CODEX_COMMAND : agentName,
        list: () => ["codex"],
      },
    });
    vi.spyOn(delegate, "ensureSession").mockImplementation(async (input) => {
      const command = runtimeCommand(runtime);
      launchCommands.push(renderAgentCommand(command));
      await wrappedStore.save({
        name: input.sessionKey,
        ...recordCommand(command),
        pid: 777,
      });
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: input.sessionKey,
      };
    });

    await runtime.ensureSession({
      sessionKey: "agent:codex:acp:binding:test",
      agent: "codex",
      mode: "persistent",
    });

    expect(leaseStore.store.save).not.toHaveBeenCalled();
    expect(launchCommands.map((command) => splitCommandParts(command))).toEqual([
      ["node", path.resolve("node_modules/@agentclientprotocol/codex-acp/dist/index.js")],
    ]);
  });

  it("recreates a missing sidecar with the persisted lease identity", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-missing ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    let savedRecord: Record<string, unknown> = {
      name: "agent:codex:acp:binding:test",
      acpxRecordId: "record-1",
      acpSessionId: "session-1",
      agentCommand: leasedCommand,
      cwd: "/tmp",
      closed: false,
    };
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => savedRecord),
      save: vi.fn(async (record) => {
        savedRecord = record;
      }),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate, wrappedStore } = makeLeasedRuntime(baseStore, leaseStore);
    vi.spyOn(delegate, "ensureSession").mockImplementation(async (input) => {
      await observeLaunch(runtime, { sessionKey: input.sessionKey, pid: 777 });
      const command = runtimeCommand(runtime);
      await wrappedStore.save({ ...savedRecord, ...recordCommand(command), pid: 777 });
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: input.sessionKey,
      };
    });

    await runtime.ensureSession({
      sessionKey: "agent:codex:acp:binding:test",
      agent: "codex",
      mode: "persistent",
    });

    expect(savedRecord.agentCommand).toBe(leasedCommand);
    expect(leaseStore.leases.get("lease-missing")).toMatchObject({
      leaseId: "lease-missing",
      rootPid: 777,
    });
    expect(leaseStore.leases.size).toBe(1);
  });

  it("does not reuse commands leased by another gateway instance", async () => {
    const foreignCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-foreign ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-foreign`;
    let savedRecord: Record<string, unknown> = {
      name: "agent:codex:acp:binding:test",
      acpxRecordId: "record-1",
      acpSessionId: "session-1",
      agentCommand: foreignCommand,
      cwd: "/tmp",
      closed: false,
      pid: 777,
    };
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => savedRecord),
      save: vi.fn(async (record) => {
        savedRecord = record;
      }),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate, wrappedStore } = makeLeasedRuntime(baseStore, leaseStore);
    const resolvedCommands: string[] = [];
    vi.spyOn(delegate, "ensureSession").mockImplementation(async (input) => {
      await observeLaunch(runtime, { sessionKey: input.sessionKey, pid: 888 });
      const command = runtimeCommand(runtime);
      resolvedCommands.push(renderAgentCommand(command));
      await wrappedStore.save({
        name: input.sessionKey,
        ...recordCommand(command),
        cwd: "/tmp",
        pid: 888,
      });
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: input.sessionKey,
      };
    });

    await runtime.ensureSession({
      sessionKey: "agent:codex:acp:binding:test",
      agent: "codex",
      mode: "persistent",
    });

    expect(resolvedCommands[0]).not.toBe(foreignCommand);
    expect(resolvedCommands[0]).toContain(`${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`);
    expect(savedRecord.pid).toBe(888);
    expect(leaseStore.leases.size).toBe(1);
  });

  it("rejects reconnect operations for commands leased by another gateway", async () => {
    const foreignCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-foreign-operation ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-foreign`;
    const handle = {
      sessionKey: "agent:codex:acp:binding:test",
      backend: "acpx" as const,
      runtimeSessionName: "agent:codex:acp:binding:test",
    };
    const expectedError = {
      code: "ACP_TURN_FAILED",
      message: "ACPX process lease lease-foreign-operation belongs to another gateway",
    };
    const createRuntime = () => {
      const baseStore: TestSessionStore = {
        load: vi.fn(async () => ({
          name: handle.sessionKey,
          agentCommand: foreignCommand,
        })),
        save: vi.fn(async () => {}),
      };
      const leaseStore = makeLeaseStore();
      const { runtime, delegate } = makeRuntime(baseStore, {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawToolsMcpBridgeEnabled: true,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
        mcpServers: [
          {
            name: "openclaw-tools",
            command: "node",
            args: ["dist/mcp/openclaw-tools-serve.js"],
            env: [],
          },
        ],
      });
      const calls = [
        vi.spyOn(delegate, "startTurn").mockImplementation(makeTurn),
        vi.spyOn(delegate, "setMode").mockResolvedValue(undefined),
        vi.spyOn(delegate, "setConfigOption").mockResolvedValue(undefined),
        vi.spyOn(delegate, "close").mockResolvedValue(undefined),
      ];
      return { runtime, leaseStore, calls };
    };
    const expectRejectedWithoutDelegate = async (
      operation: (runtime: AcpxRuntime) => Promise<unknown>,
    ) => {
      const { runtime, leaseStore, calls } = createRuntime();
      await expect(operation(runtime)).rejects.toMatchObject(expectedError);
      for (const call of calls) {
        expect(call).not.toHaveBeenCalled();
      }
      expect(leaseStore.leases.size).toBe(0);
    };

    await expectRejectedWithoutDelegate((runtime) =>
      runtime.setConfigOption({ handle, key: "thinking", value: "minimal" }),
    );
    await expectRejectedWithoutDelegate((runtime) => runtime.setMode({ handle, mode: "plan" }));
    await expectRejectedWithoutDelegate((runtime) => runtime.close({ handle, reason: "done" }));

    const { runtime, leaseStore, calls } = createRuntime();
    const turn = runtime.startTurn({
      handle,
      text: "Reply exactly OK",
      mode: "prompt",
      requestId: "foreign-gateway",
    });
    const outcomes = await Promise.allSettled([turn.result, turn.cancel(), turn.closeStream()]);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject(expectedError);
      }
    }
    for (const call of calls) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(leaseStore.leases.size).toBe(0);
  });

  it("serializes concurrent persistent ensures for one session", async () => {
    let savedRecord: Record<string, unknown> | undefined;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => savedRecord),
      save: vi.fn(async (record) => {
        savedRecord = record;
      }),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate, wrappedStore } = makeLeasedRuntime(baseStore, leaseStore);
    const { promise: firstBlocked, resolve: releaseFirst } = createDeferred<void>();
    let entered = 0;
    let active = 0;
    let maxActive = 0;
    const resolvedCommands: string[] = [];
    const ensure = vi.spyOn(delegate, "ensureSession").mockImplementation(async (input) => {
      entered += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      const command = runtimeCommand(runtime);
      resolvedCommands.push(renderAgentCommand(command));
      if (entered === 1) {
        await observeLaunch(runtime, { sessionKey: input.sessionKey, pid: 777 });
        await wrappedStore.save({
          name: input.sessionKey,
          acpSessionId: "session-1",
          ...recordCommand(command),
          cwd: "/tmp",
          pid: 777,
        });
        await firstBlocked;
      } else if (savedRecord) {
        await wrappedStore.save(savedRecord);
      }
      active -= 1;
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: input.sessionKey,
      };
    });
    const ensureInput = {
      sessionKey: "agent:codex:acp:binding:test",
      agent: "codex",
      mode: "persistent" as const,
    };

    const first = runtime.ensureSession(ensureInput);
    while (ensure.mock.calls.length === 0) {
      await Promise.resolve();
    }
    const second = runtime.ensureSession(ensureInput);
    await Promise.resolve();
    expect(ensure).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);

    expect(maxActive).toBe(1);
    expect(resolvedCommands[1]).toBe(resolvedCommands[0]);
    expect(leaseStore.leases.size).toBe(1);
  });

  it("adopts legacy persistent commands before their next reconnect", async () => {
    let savedRecord: Record<string, unknown> = {
      name: "agent:codex:acp:binding:test",
      acpxRecordId: "record-1",
      acpSessionId: "session-1",
      agentCommand: CODEX_ACP_WRAPPER_COMMAND,
      cwd: "/tmp",
      closed: false,
      pid: 777,
    };
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => savedRecord),
      save: vi.fn(async (record) => {
        savedRecord = record;
      }),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate, wrappedStore } = makeLeasedRuntime(baseStore, leaseStore);
    const resolvedCommands: string[] = [];
    vi.spyOn(delegate, "ensureSession").mockImplementation(async (input) => {
      resolvedCommands.push(renderAgentCommand(runtimeCommand(runtime)));
      await wrappedStore.save(savedRecord);
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: input.sessionKey,
      };
    });

    await runtime.ensureSession({
      sessionKey: "agent:codex:acp:binding:test",
      agent: "codex",
      mode: "persistent",
    });

    expect(resolvedCommands).toEqual([CODEX_ACP_WRAPPER_COMMAND]);
    expect(savedRecord.agentCommand).toContain(OPENCLAW_ACPX_LEASE_ID_ARG);
    expect(savedRecord.agentCommand).toContain(OPENCLAW_GATEWAY_INSTANCE_ID_ARG);
    expect(savedRecord.pid).toBeUndefined();
    expect(leaseStore.leases.size).toBe(0);

    await observeLaunch(runtime, {
      sessionKey: "agent:codex:acp:binding:test",
      command: String(savedRecord.agentCommand),
      pid: 888,
    });
    await wrappedStore.save({ ...savedRecord, pid: 888 });

    const [lease] = Array.from(leaseStore.leases.values());
    expect(lease?.leaseId).toBe(savedRecord.openclawLeaseId);
    expect(lease?.rootPid).toBe(888);
  });

  it("keeps pending process leases when a fresh launch fails after spawn may have occurred", async () => {
    const baseStore: TestSessionStore = makeEmptySessionStore();
    const leaseStore = makeLeaseStore();
    const { runtime, delegate } = makeLeasedRuntime(baseStore, leaseStore);
    vi.spyOn(delegate, "ensureSession").mockImplementation(async (input) => {
      await observeLaunch(runtime, { sessionKey: input.sessionKey });
      throw new Error("launch failed");
    });

    await expect(
      runtime.ensureSession({
        sessionKey: "agent:codex:acp:binding:test",
        agent: "codex",
        mode: "persistent",
      }),
    ).rejects.toThrow("launch failed");

    expect(Array.from(leaseStore.leases.values())).toEqual([
      expect.objectContaining({ rootPid: 0, state: "open" }),
    ]);
    expect(leaseStore.store.markState).not.toHaveBeenCalledWith(expect.any(String), "lost");
  });

  it("preserves promoted process leases when session setup later fails", async () => {
    let savedRecord: Record<string, unknown> | undefined;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => savedRecord),
      save: vi.fn(async (record) => {
        savedRecord = record;
      }),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate, wrappedStore } = makeLeasedRuntime(baseStore, leaseStore);
    vi.spyOn(delegate, "ensureSession").mockImplementation(async (input) => {
      await observeLaunch(runtime, { sessionKey: input.sessionKey, pid: 777 });
      const command = runtimeCommand(runtime);
      await wrappedStore.save({
        name: input.sessionKey,
        ...recordCommand(command),
        cwd: "/tmp",
        pid: 777,
      });
      throw new Error("setup failed after spawn");
    });

    await expect(
      runtime.ensureSession({
        sessionKey: "agent:codex:acp:binding:test",
        agent: "codex",
        mode: "persistent",
      }),
    ).rejects.toThrow("setup failed after spawn");

    const [lease] = Array.from(leaseStore.leases.values());
    expect(lease?.rootPid).toBe(777);
    expect(leaseStore.leases.size).toBe(1);
  });

  it("records the actual reconnect PID instead of inferring ownership from a persisted PID", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-live-reconnect ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        agentCommand: leasedCommand,
        pid: 777,
      })),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
    });
    vi.spyOn(delegate, "startTurn").mockImplementation((input) =>
      makeTurn(input, {
        result: (async () => {
          expect(leaseStore.store.save).not.toHaveBeenCalled();
          await observeLaunch(runtime, {
            command: leasedCommand,
            sessionKey: input.handle.sessionKey,
            pid: 888,
          });
          return { status: "completed" };
        })(),
      }),
    );

    await runtime.startTurn({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      text: "Reply exactly OK",
      mode: "prompt",
      requestId: "turn-live-reconnect",
    }).result;

    expect(leaseStore.leases.get("lease-live-reconnect")).toMatchObject({
      rootPid: 888,
      state: "open",
    });
  });

  it("keeps reconnect intent until explicit cleanup proves the process is absent", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-start-reconnect ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        agentCommand: leasedCommand,
      })),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
      },
      { openclawProcessCleanup: { listProcesses: async () => [] } },
    );
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);
    vi.spyOn(delegate, "startTurn").mockImplementation((input) =>
      makeTurn(input, {
        result: (async () => {
          await observeLaunch(runtime, {
            command: leasedCommand,
            sessionKey: input.handle.sessionKey,
          });
          expect(leaseStore.leases.get("lease-start-reconnect")).toMatchObject({
            rootPid: 0,
            sessionKey: input.handle.sessionKey,
          });
          return { status: "completed" };
        })(),
      }),
    );

    const turn = runtime.startTurn({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      text: "Reply exactly OK",
      mode: "prompt",
      requestId: "start-reconnect",
    });

    await expect(turn.result).resolves.toEqual({ status: "completed" });
    expect(leaseStore.leases.size).toBe(1);
    await runtime.close({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "explicit-close",
    });
    expect(leaseStore.leases.size).toBe(0);
  });

  it("joins abandoned runTurn cancellation and leaves uncertain process cleanup to close", async () => {
    const leaseId = "lease-abandoned-turn";
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} ${leaseId} ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const sessionKey = "agent:codex:acp:abandoned";
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({ name: sessionKey, agentCommand: leasedCommand })),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
      },
      { openclawProcessCleanup: { listProcesses: async () => [] } },
    );
    await observeLaunch(runtime, { sessionKey, command: leasedCommand });
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);
    const result = createDeferred<{ status: "cancelled" }>();
    const cancel = vi.fn(async () => {});
    const output = async function* () {
      yield { type: "text_delta" as const, text: "Partial progress" };
    };
    vi.spyOn(delegate, "startTurn").mockImplementation((input) => ({
      requestId: input.requestId,
      promptStarted: Promise.resolve(),
      events: output(),
      result: result.promise,
      cancel,
      closeStream: vi.fn(async () => {}),
    }));
    const events = runtime.runTurn({
      handle: { sessionKey, backend: "acpx", runtimeSessionName: sessionKey },
      text: "Do work",
      mode: "prompt",
      requestId: "abandoned-turn",
    });
    const iterator = events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text_delta", text: "Partial progress" },
    });
    let returned = false;
    const closing = iterator.return?.().then(() => {
      returned = true;
    });

    try {
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(returned).toBe(false);
      expect(leaseStore.leases.has(leaseId)).toBe(true);
      result.resolve({ status: "cancelled" });
      await closing;
      expect(leaseStore.leases.size).toBe(1);
      await runtime.close({
        handle: { sessionKey, backend: "acpx", runtimeSessionName: sessionKey },
        reason: "explicit-close",
      });
      expect(leaseStore.leases.size).toBe(0);
    } finally {
      result.resolve({ status: "cancelled" });
      await closing;
    }
  });

  it("preserves a promoted PID when the session record save fails", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-partial-save ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const savedRecord: Record<string, unknown> = {
      name: "agent:codex:acp:binding:test",
      agentCommand: leasedCommand,
      pid: 777,
    };
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => savedRecord),
      save: vi.fn(async () => {
        throw new Error("session save failed");
      }),
    };
    const leaseStore = makeLeaseStore();
    seedLease(leaseStore, "lease-partial-save", 777, 1);
    const { runtime, delegate, wrappedStore } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
    });
    vi.spyOn(delegate, "setMode").mockImplementation(async () => {
      await observeLaunch(runtime, {
        command: leasedCommand,
        sessionKey: "agent:codex:acp:binding:test",
        pid: 888,
      });
      await wrappedStore.save({ ...savedRecord, pid: 888 });
    });

    await expect(
      runtime.setMode({
        handle: {
          sessionKey: "agent:codex:acp:binding:test",
          backend: "acpx",
          runtimeSessionName: "agent:codex:acp:binding:test",
        },
        mode: "plan",
      }),
    ).rejects.toThrow("session save failed");

    expect(leaseStore.leases.get("lease-partial-save")).toMatchObject({
      rootPid: 888,
      state: "open",
    });
  });

  it("keeps close pending leases when cleanup fails", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-close-failure ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        agentCommand: leasedCommand,
      })),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
    });
    await observeLaunch(runtime, {
      command: leasedCommand,
      sessionKey: "agent:codex:acp:binding:test",
    });
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);
    leaseStore.store.load
      .mockResolvedValueOnce(await leaseStore.store.load("lease-close-failure"))
      .mockRejectedValueOnce(new Error("cleanup failed"));

    await expect(
      runtime.close({
        handle: {
          sessionKey: "agent:codex:acp:binding:test",
          backend: "acpx",
          runtimeSessionName: "agent:codex:acp:binding:test",
        },
        reason: "user-close",
      }),
    ).rejects.toThrow("cleanup failed");

    expect(delegate.close).toHaveBeenCalledOnce();
    expect(leaseStore.leases.get("lease-close-failure")).toMatchObject({
      rootPid: 0,
      state: "open",
    });
  });

  it("preserves PID-bearing close leases when cleanup fails", async () => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-close-live ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        agentCommand: leasedCommand,
        pid: 777,
      })),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    seedLease(leaseStore, "lease-close-live", 777, 1);
    const { runtime, delegate } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
    });
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);
    leaseStore.store.listOpen.mockRejectedValue(new Error("cleanup failed"));

    await expect(
      runtime.close({
        handle: {
          sessionKey: "agent:codex:acp:binding:test",
          backend: "acpx",
          runtimeSessionName: "agent:codex:acp:binding:test",
        },
        reason: "user-close",
      }),
    ).rejects.toThrow("cleanup failed");

    expect(delegate.close).toHaveBeenCalledOnce();
    expect(leaseStore.leases.get("lease-close-live")).toMatchObject({
      rootPid: 777,
      state: "open",
    });
  });

  it.each([
    {
      evidence: "process listing is unavailable",
      processCleanup: {
        listProcesses: vi.fn(async () => {
          throw new Error("process listing unavailable");
        }),
      },
    },
    {
      evidence: "Windows process evidence is unsupported",
      processCleanup: {
        platform: "win32" as const,
        listProcesses: vi.fn(async () => []),
      },
    },
  ])("keeps close leases retryable when $evidence", async ({ processCleanup }) => {
    const leasedCommand = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-close-process-list ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        agentCommand: leasedCommand,
        pid: 777,
      })),
      save: vi.fn(async () => {}),
    };
    const leaseStore = makeLeaseStore();
    seedLease(leaseStore, "lease-close-process-list", 777, 1);
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
      },
      {
        openclawProcessCleanup: {
          ...processCleanup,
          sleep: vi.fn(async () => {}),
        },
      },
    );
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);

    await runtime.close({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "user-close",
    });

    expect(leaseStore.leases.get("lease-close-process-list")).toMatchObject({
      rootPid: 777,
      state: "open",
    });
    if ("platform" in processCleanup && processCleanup.platform === "win32") {
      expect(processCleanup.listProcesses).not.toHaveBeenCalled();
    }
  });

  it("merges the lease for the current ACPX session process when old leases exist", async () => {
    const leaseStore = makeLeaseStore();
    seedLease(leaseStore, "lease-old", 700, 1);
    seedLease(leaseStore, "lease-current", 777, 2);
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        name: "agent:codex:acp:binding:test",
        agentCommand: 'node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"',
        pid: 777,
      })),
      save: vi.fn(async () => {}),
    };
    const { wrappedStore } = makeRuntime(baseStore, {
      openclawGatewayInstanceId: "gateway-test",
      openclawProcessLeaseStore: leaseStore.store,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
    });

    const loadedRecord = await wrappedStore.load("agent:codex:acp:binding:test");
    expect(loadedRecord?.openclawGatewayInstanceId).toBe("gateway-test");
    expect(loadedRecord?.openclawLeaseId).toBe("lease-current");
  });

  it("closes the current process lease when the saved lease id is stale", async () => {
    const leaseStore = makeLeaseStore();
    seedLease(leaseStore, "lease-old", 930, 1);
    seedLease(leaseStore, "lease-current", 940, 2);
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:binding:test",
        agentCommand: 'node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"',
        openclawLeaseId: "lease-old",
        pid: 940,
      })),
      save: vi.fn(async () => {}),
    };
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => [
            {
              pid: 930,
              ppid: 1,
              command: `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-old ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`,
            },
            {
              pid: 940,
              ppid: 1,
              command: `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-current ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`,
            },
            { pid: 941, ppid: 940, command: "node child.js" },
          ]),
          killProcess: vi.fn((pid, signal) => {
            killed.push({ pid, signal });
          }),
          sleep: vi.fn(async () => {}),
        },
      },
    );
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);

    await runtime.close({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "user-close",
    });

    expect(killed.slice(0, 2)).toEqual([
      { pid: 941, signal: "SIGTERM" },
      { pid: 940, signal: "SIGTERM" },
    ]);
    expect(leaseStore.store.markState.mock.calls).toEqual([
      ["lease-current", "closing"],
      ["lease-current", "closed"],
    ]);
  });

  it("does not clean up a stale close pid reused by another wrapper root", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:binding:test",
        agentCommand: 'node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"',
        pid: 920,
      })),
      save: vi.fn(async () => {}),
    };
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {
        openclawWrapperRoot: "/tmp/openclaw/acpx",
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => [
            {
              pid: 920,
              ppid: 1,
              command: 'node "/tmp/other-gateway/acpx/codex-acp-wrapper.mjs"',
            },
          ]),
          killProcess: vi.fn((pid, signal) => {
            killed.push({ pid, signal });
          }),
          sleep: vi.fn(async () => {}),
        },
      },
    );
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);

    await runtime.close({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "user-close",
    });

    expect(killed).toStrictEqual([]);
  });

  it("cleans up non-lease-aware wrapper commands through fallback close cleanup", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:binding:test",
        agentCommand: CODEX_ACP_WRAPPER_COMMAND,
        pid: 920,
      })),
      save: vi.fn(async () => {}),
    };
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawWrapperRoot: "/tmp/openclaw/acpx",
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => [
            {
              pid: 920,
              ppid: 1,
              command: CODEX_ACP_WRAPPER_COMMAND,
            },
            { pid: 921, ppid: 920, command: "node child.js" },
          ]),
          killProcess: vi.fn((pid, signal) => {
            killed.push({ pid, signal });
          }),
          sleep: vi.fn(async () => {}),
        },
      },
    );
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);

    await runtime.close({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "user-close",
    });

    expect(killed.slice(0, 2)).toEqual([
      { pid: 921, signal: "SIGTERM" },
      { pid: 920, signal: "SIGTERM" },
    ]);
  });

  it("uses session lease metadata for fallback close cleanup identity checks", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:binding:test",
        agentCommand: 'node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"',
        openclawGatewayInstanceId: "gateway-test",
        openclawLeaseId: "lease-record",
        pid: 920,
      })),
      save: vi.fn(async () => {}),
    };
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const { runtime, delegate } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawWrapperRoot: "/tmp/openclaw/acpx",
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => [
            {
              pid: 920,
              ppid: 1,
              command: `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} other-lease ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`,
            },
          ]),
          killProcess: vi.fn((pid, signal) => {
            killed.push({ pid, signal });
          }),
          sleep: vi.fn(async () => {}),
        },
      },
    );
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);

    await runtime.close({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "user-close",
    });

    expect(killed).toStrictEqual([]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
