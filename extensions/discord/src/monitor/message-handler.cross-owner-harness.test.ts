import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import {
  getAcpSessionManager,
  registerAcpRuntimeBackend,
  tryDispatchAcpReplyHook,
  unregisterAcpRuntimeBackend,
} from "openclaw/plugin-sdk/acp-runtime";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { withPluginRuntimeRegistryScope } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  createTestRegistry,
  initializeGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createReplyDispatcher, dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/thread-bindings-session-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { discordPlugin } from "../../channel-plugin-api.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
  createThreadClient,
} from "./message-handler.preflight.test-helpers.js";
import { resolveDiscordPreflightRoute } from "./message-handler.routing-preflight.js";

// ACP session admission opens shared state on the host thread, so this file
// runs in the extension database-worker shard rather than the Discord thread pool.
const scope = { channel: "discord", accountId: "default" };
const proofBackendId = "proof-harness";
const proofTargetSessionKey = "agent:claude:acp:binding:discord:default:af00112233445566";
type Conversation = Parameters<SessionBindingAdapter["resolveByConversation"]>[0];
let state: OpenClawTestState;

beforeAll(async () => {
  state = await createOpenClawTestState({
    label: "discord-cross-owner-harness",
    env: { OPENCLAW_TEST_FAST: "0" },
  });
});
afterAll(async () => await state.cleanup());
beforeEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordPlugin }]),
  );
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
});

function proofHarnessLines(proofLog: string): string[] {
  try {
    return readFileSync(proofLog, "utf8")
      .split("\n")
      .filter((line) => line.includes('"event":"harness_io"'));
  } catch {
    return [];
  }
}

function recordProofHarnessIo(proofLog: string, sessionKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        [
          'require("node:fs").appendFileSync(',
          "process.argv[1],",
          'JSON.stringify({event:"harness_io",sessionKey:process.argv[2]})+"\\n"',
          ")",
        ].join(""),
        proofLog,
        sessionKey,
      ],
      { stdio: "ignore" },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`harness process exited ${code}`));
    });
  });
}

it.each(["kept", "removed", "reassigned"] as const)(
  "performs cross-owner harness I/O only while the ACP binding stays %s",
  async (change) => {
    const proofLog = state.path(`harness-io-${change}.log`);
    appendFileSync(proofLog, "");
    const threadId = `thread-proof-${change}`;
    const parentId = "channel-parent";
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          main: { workspace: state.path(`${change}-proof-main`) },
          claude: { workspace: state.path(`${change}-proof-claude`) },
        },
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          model: { primary: "openai/gpt-5.4" },
        },
      },
      plugins: { enabled: true, allow: ["acpx", "discord"], entries: { acpx: { enabled: true } } },
      skills: { load: { watch: false } },
      channels: { discord: { enabled: true } },
      bindings: [{ agentId: "main", match: scope }],
      acp: { enabled: true, backend: proofBackendId, dispatch: { enabled: true } },
    };
    setRuntimeConfigSnapshot(cfg);
    onTestFinished(() => {
      clearRuntimeConfigSnapshot();
      unregisterAcpRuntimeBackend(proofBackendId);
    });
    const message = createDiscordMessage({
      id: `m-proof-${change}`,
      channelId: threadId,
      content: "continue the work",
      author: { id: "user-1", bot: false, username: "alice" },
    });
    const author = message.author;
    if (!author) {
      throw new Error("Expected a sender in the Discord fixture");
    }
    const conversation = {
      ...scope,
      conversationId: threadId,
      parentConversationId: parentId,
    };
    let current: SessionBindingRecord | null = {
      bindingId: `runtime-acp-proof-${change}`,
      targetSessionKey: proofTargetSessionKey,
      targetKind: "session",
      status: "active",
      boundAt: 1,
      conversation,
      metadata: { agentId: "worker" },
    };
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const lookup = (ref: Conversation) =>
      ref.conversationId === conversation.conversationId ? current : null;
    const read = vi.fn(async (ref: Conversation) => {
      entered.resolve();
      await release.promise;
      return lookup(ref);
    });
    const preflight = createDiscordPreflightArgs({
      cfg,
      discordConfig: cfg.channels?.discord ?? {},
      data: createGuildEvent({ channelId: threadId, guildId: "guild-1", author, message }),
      client: createThreadClient({ threadId, parentId }),
    });
    const adapter: SessionBindingAdapter = {
      ...scope,
      listBySession: () => (current ? [current] : []),
      resolveByConversation: lookup,
      inspectByConversationAsync: read,
      resolveByConversationAsync: read,
      touchAsync: async () => {},
    };
    registerSessionBindingAdapter(adapter);
    onTestFinished(() => unregisterSessionBindingAdapter({ ...scope, adapter }));
    const routed = await resolveDiscordPreflightRoute({
      preflight,
      author,
      isDirectMessage: false,
      isGroupDm: false,
      messageChannelId: threadId,
      memberRoleIds: [],
      earlyThreadParentId: parentId,
    });
    expect(routed.boundSessionKey).toBe(proofTargetSessionKey);
    expect(routed.effectiveRoute.agentId).toBe("main");
    expect(routed.effectiveRoute.sessionKey).not.toContain(":acp:");
    registerAcpRuntimeBackend({
      id: proofBackendId,
      runtime: {
        async ensureSession(input) {
          return {
            sessionKey: input.sessionKey,
            agentId: input.agentId,
            backend: proofBackendId,
            runtimeSessionName: input.sessionKey,
          };
        },
        async *runTurn(input) {
          await recordProofHarnessIo(proofLog, input.handle.sessionKey);
          yield { type: "done" };
        },
        async cancel() {},
        async close() {},
      },
    });
    const registryBuilder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntimeMock(),
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({
      id: "acpx",
      origin: "bundled",
      source: state.path("plugin", "acpx", "index.ts"),
      status: "loaded",
    });
    const api = registryBuilder.createApi(record, { config: cfg });
    registryBuilder.registry.plugins.push(record);
    api.on("reply_dispatch", tryDispatchAcpReplyHook, { eligibleDispatchKinds: ["acp"] });
    setActivePluginRegistry(registryBuilder.registry);
    initializeGlobalHookRunner(registryBuilder.registry);
    // The ACP child already exists from spawn. The follow-up itself goes through reply dispatch.
    await getAcpSessionManager().initializeSession({
      cfg,
      sessionKey: proofTargetSessionKey,
      agentId: "claude",
      agent: "proof",
      mode: "persistent",
    });
    const ctx = buildChannelInboundEventContext({
      ...scope,
      messageId: `proof-${change}`,
      from: `discord:channel:${threadId}`,
      sender: { id: "user-1" },
      conversation: { kind: "channel", id: threadId, parentId },
      route: {
        ...routed.effectiveRoute,
        routeSessionKey: routed.effectiveRoute.sessionKey,
        dispatchSessionKey: routed.effectiveRoute.sessionKey,
      },
      reply: { to: `channel:${threadId}` },
      access: { commands: { authorized: true } },
      message: { rawBody: "continue the work" },
    });
    const before = proofHarnessLines(proofLog).length;
    const dispatcher = createReplyDispatcher({
      deliver: async () => {},
    });
    const settled = withPluginRuntimeRegistryScope(registryBuilder.registry, () =>
      dispatchInboundMessage({ ctx, cfg, dispatcher }),
    ).then(
      (reply) => reply,
      (error: unknown) => error,
    );
    await Promise.race([entered.promise, settled]);
    if (change === "removed") {
      current = null;
    } else if (change === "reassigned") {
      current = {
        ...current!,
        boundAt: 2,
        targetSessionKey: "agent:claude:acp:binding:discord:default:bb00112233445566",
      };
    }
    release.resolve();
    const outcome = await settled;
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    const harnessLines = proofHarnessLines(proofLog).slice(before);
    const error =
      outcome && typeof outcome === "object" && "code" in outcome
        ? String((outcome as { code: unknown }).code)
        : null;
    console.log(
      `PROOF146651 ${JSON.stringify({
        case: change,
        admissionAgent: ctx.AgentId,
        admissionSession: ctx.SessionKey,
        boundTarget: proofTargetSessionKey,
        error,
        message:
          outcome && typeof outcome === "object" && "message" in outcome
            ? String((outcome as { message: unknown }).message).slice(0, 240)
            : null,
        harnessIo: harnessLines,
      })}`,
    );
    expect(ctx.AgentId).toBe("main");
    expect(ctx.SessionKey).not.toContain(":acp:");
    if (change === "kept") {
      expect(error).toBeNull();
      expect(harnessLines).toEqual([
        JSON.stringify({ event: "harness_io", sessionKey: proofTargetSessionKey }),
      ]);
      return;
    }
    expect(error).toBe("SESSION_WORK_START_CHANGED");
    expect(harnessLines).toEqual([]);
  },
);

it("drops an unauthorized Discord sender before harness I/O", async () => {
  const proofLog = state.path("harness-io-unauthorized.log");
  appendFileSync(proofLog, "");
  const channelId = "channel-unauthorized";
  const guildId = "guild-unauthorized";
  const message = createDiscordMessage({
    id: "m-unauthorized",
    channelId,
    content: "continue the work",
    author: { id: "user-denied", bot: false, username: "mallory" },
  });
  const author = message.author;
  if (!author) {
    throw new Error("Expected a sender in the Discord fixture");
  }
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", defaults: { workspace: state.workspaceDir } },
    channels: { discord: { enabled: true, groupPolicy: "allowlist" } },
    skills: { load: { watch: false } },
  };
  const preflightModule = "./message-handler.preflight.js";
  const { preflightDiscordMessage } = await import(preflightModule);
  const admitted = await preflightDiscordMessage({
    ...createDiscordPreflightArgs({
      cfg,
      discordConfig: cfg.channels?.discord ?? {},
      data: createGuildEvent({ channelId, guildId, author, message }),
      client: createGuildTextClient(channelId),
    }),
    guildEntries: {
      [guildId]: {
        channels: {
          [channelId]: { enabled: true, users: ["user-allowed"] },
        },
      },
    },
  });
  const proof = {
    case: "unauthorized-sender",
    preflight: admitted ? "admitted" : "dropped",
    harnessIo: proofHarnessLines(proofLog),
  };
  console.log(`PROOF146651 ${JSON.stringify(proof)}`);
  expect(admitted).toBeNull();
  expect(proof.harnessIo).toEqual([]);
});
