import { afterEach, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { prepareReplyToolAuthority } from "../auto-reply/reply/reply-tool-authority.js";
import { transferRequesterProfile } from "../auto-reply/requester-profile.js";
import { prepareTurn } from "../gateway/server-methods/chat-send-user-turn-family.test-support.js";
import { createClientInfo } from "../gateway/server-methods/chat-send-user-turn.test-support.js";
import type { GatewayClient } from "../gateway/server-methods/client-types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { bindPluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-binding.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { OpenClawPluginToolContext } from "../plugins/tool-types.js";
import { testing as replyTesting } from "../sessions/session-controller.test-support.js";
import {
  createOperationalRunInstanceRef,
  createAdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import { withPreparedEmbeddedGatewayTools } from "./embedded-agent-runner/run/attempt-gateway-tools.js";
import { withPreparedEmbeddedRunToolAuthority } from "./harness/tool-authority.runtime.js";
import {
  admitted,
  attempt,
  createDirectReplyOperation,
} from "./harness/tool-authority.runtime.test-support.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

type FixtureKind =
  | "ui"
  | "non-admin"
  | "cli"
  | "synthetic"
  | "unverified"
  | "shared-owner"
  | "system"
  | "json"
  | "forged"
  | "mismatched-origin"
  | "authority-mismatch"
  | "agent-ingress";
type ToolTarget = {
  runId?: string;
  sessionId?: string;
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
};
const config = { plugins: { enabled: true, entries: { "room-probe": { enabled: true } } } };

afterEach(() => replyTesting.resetSessionControllerForTest());

async function fixture(
  run: (fixture: {
    tools: ReturnType<typeof resolveOpenClawPluginToolsForOptions>;
    client: GatewayClient;
    close: () => void;
    disconnect: () => void;
    steer: () => void;
    construct: (target?: ToolTarget) => ReturnType<typeof resolveOpenClawPluginToolsForOptions>;
    revoke: () => void;
    context: () => OpenClawPluginToolContext<2> | undefined;
    beforeEffect: (wait: () => Promise<void>) => void;
    effects: string[];
  }) => Promise<void>,
  kind: FixtureKind = "ui",
) {
  const connection = new AbortController();
  const owner = kind !== "non-admin";
  const scopes = owner ? ["operator.admin"] : ["operator.read", "operator.write"];
  const profileId = kind === "shared-owner" ? GATEWAY_OWNER_PROFILE_ID : "profile-ada";
  const clientInfo = createClientInfo(
    kind === "cli"
      ? {}
      : {
          id: GATEWAY_CLIENT_IDS.CONTROL_UI,
          mode: GATEWAY_CLIENT_MODES.UI,
        },
  );
  const client: GatewayClient = {
    connId: "profile-tab",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: clientInfo,
      role: "operator",
      scopes,
    },
    authenticatedUserId: kind === "unverified" ? undefined : "ada@example.test",
    authenticatedUserProfile: {
      profileId,
      displayName: "Ada",
      hasAvatar: false,
      updatedAt: 1,
    },
    internal: {
      authenticatedOperator: kind !== "unverified" ? true : undefined,
      syntheticClient: kind === "synthetic" ? true : undefined,
    },
    connectionSignal: connection.signal,
  };
  const inputProvenance =
    kind === "system" ? { kind: "internal_system" as const, sourceTool: "fixture" } : undefined;
  const prepare = () =>
    prepareTurn({
      client,
      request: { clientInfo, systemInputProvenance: inputProvenance },
    });
  const preparedTurn =
    kind === "agent-ingress"
      ? await withGatewayToolCallerIdentity(
          { agentId: "main", sessionKey: attempt.sessionKey },
          prepare,
        )
      : prepare();
  // Exercise the wire boundary, which must discard host-only identity bindings.
  const serializedInput = kind === "json" ? JSON.stringify(preparedTurn.ctx) : undefined;
  const ctx = finalizeInboundContext(
    serializedInput ? JSON.parse(serializedInput) : { ...preparedTurn.ctx },
  );
  if (kind === "forged") {
    Object.assign(ctx, { requesterProfile: { id: profileId, isCurrent: () => true } });
    for (const symbol of Object.getOwnPropertySymbols(ctx)) {
      if (symbol.description === "openclaw.requesterProfile") {
        Reflect.set(ctx, symbol, { id: profileId, isCurrent: () => true });
      }
    }
  }
  if (kind === "mismatched-origin") {
    ctx.OriginatingChannel = "telegram";
  }
  let revoked = false;
  const operatorAuthority = createAdmittedRunOperatorAuthority({
    profileId: kind === "authority-mismatch" ? "profile-other" : profileId,
    scopes,
    assertCurrent() {
      if (revoked) {
        throw new Error("operator revoked");
      }
    },
  });
  const input = {
    operatorAuthority,
    originatingChannel: "webchat",
    run: {
      ...attempt,
      config,
      senderId: ctx.SenderId,
      senderIsOwner: owner,
      inputProvenance,
      model: attempt.modelId,
      gatewayUiCommandTarget: ctx.GatewayUiCommandTarget,
    },
  };
  transferRequesterProfile(ctx, input);
  const operation = createDirectReplyOperation();
  await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(input));
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "room-probe",
    origin: "bundled",
    rootDir: "/synthetic/room-probe",
    source: "/synthetic/room-probe/index.js",
    contracts: { tools: ["room_read", "room_draft"] },
  });
  bindPluginRuntimeArtifactSelection(record, {
    preferBuiltPluginArtifacts: false,
    runtimeEntry: { source: record.source, rootDir: record.rootDir! },
  });
  builder.registry.plugins.push(record);
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: record.id,
        origin: "bundled",
        rootDir: record.rootDir!,
        source: record.source,
        enabledByDefault: true,
        contracts: record.contracts,
      },
    ],
  });
  setPluginRuntimeLoadContext(builder.registry, {
    rawConfig: config,
    config,
    activationSourceConfig: config,
    autoEnabledReasons: {},
    workspaceDir: attempt.workspaceDir,
    env: process.env,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    manifestRegistry: snapshot.manifestRegistry,
    metadataSnapshot: snapshot,
  });
  let context: OpenClawPluginToolContext<2> | undefined;
  let wait = async () => {};
  const effects: string[] = [];
  builder.createApi(record, { config, registrationMode: "full" }).registerTool(
    {
      contextVersion: 2,
      create(value) {
        context = value;
        const profile = value.requesterProfile;
        if (value.senderIsOwner !== true || !profile) {
          return null;
        }
        return ["room_read", "room_draft"].map((name) => ({
          name,
          label: name,
          description: name,
          parameters: { type: "object", properties: {} },
          async execute() {
            await wait();
            value.assertInvocationCurrent();
            profile.assertCurrent();
            effects.push(name + ":" + profile.id);
            return { content: [], details: { profileId: profile.id } };
          },
        }));
      },
    },
    { names: ["room_read", "room_draft"], workspaceAccess: false },
  );
  try {
    await admitted(
      async ({ admittedRunContext, close }) =>
        withPreparedEmbeddedGatewayTools(
          { ...input.run, admittedRunContext, agentHarnessId: "embedded" },
          () =>
            withPreparedEmbeddedRunToolAuthority(
              { admittedRunContext, replyOperation: operation },
              { ...input.run, modelId: attempt.modelId },
              undefined,
              async () => {
                const construct = (target: ToolTarget = {}) =>
                  withPluginRuntimeRegistryScope(builder.registry, () =>
                    resolveOpenClawPluginToolsForOptions({
                      options: {
                        config,
                        workspaceDir: attempt.workspaceDir,
                        agentSessionKey: attempt.sessionKey,
                        sessionId: attempt.sessionId,
                        runId: attempt.runId,
                        agentChannel: "webchat",
                        senderIsOwner: owner,
                        requesterSenderId: ctx.SenderId,
                        ...target,
                      },
                    }),
                  );
                await run({
                  tools: construct(),
                  construct,
                  client,
                  disconnect: () => connection.abort(),
                  steer: () =>
                    operation.personalToolParticipants!.accept({
                      operatorAuthority: createAdmittedRunOperatorAuthority({
                        profileId: "profile-grace",
                        scopes,
                        assertCurrent() {},
                      }),
                    }),
                  close,
                  revoke: () => {
                    revoked = true;
                  },
                  context: () => context,
                  beforeEffect: (next) => {
                    wait = next;
                  },
                  effects,
                });
              },
            ),
        ),
      operatorAuthority,
    );
  } finally {
    operation.complete();
    await disposePluginRegistryInstances(builder.registry);
  }
}

it("lets the verified UI requester read and create an unsent draft without a transport sender", async () => {
  await fixture(async ({ tools, context, effects }) => {
    expect(context()?.senderIsOwner).toBe(true);
    expect(context()?.requesterSenderId).toBeUndefined();
    expect(tools.map((tool) => tool.name)).toEqual(["room_read", "room_draft"]);
    for (const tool of tools) {
      await tool.execute(tool.name, {});
    }
    expect(effects).toEqual(["room_read:profile-ada", "room_draft:profile-ada"]);
  });
});

it.each(["disconnect", "revoke", "replace-profile", "close-run", "steer"] as const)(
  "rejects %s after awaited work, before the draft effect",
  async (reason) => {
    await fixture(
      async ({ tools, client, revoke, close, disconnect, steer, beforeEffect, effects }) => {
        expect(tools).toHaveLength(2);
        const entered = createDeferred();
        const resume = createDeferred();
        beforeEffect(async () => {
          entered.resolve();
          await resume.promise;
        });
        const pending = tools[1]!.execute("draft", {});
        await entered.promise;
        if (reason === "disconnect") {
          disconnect();
        }
        if (reason === "steer") {
          steer();
        }
        if (reason === "revoke") {
          revoke();
        }
        if (reason === "replace-profile") {
          client.authenticatedUserProfile = {
            profileId: "profile-other",
            displayName: "Other",
            hasAvatar: false,
            updatedAt: 2,
          };
        }
        if (reason === "close-run") {
          close();
        }
        resume.resolve();
        await expect(pending).rejects.toThrow();
        expect(effects).toEqual([]);
      },
    );
  },
);

it.each<FixtureKind>([
  "non-admin",
  "cli",
  "synthetic",
  "unverified",
  "shared-owner",
  "system",
  "json",
  "forged",
  "mismatched-origin",
  "authority-mismatch",
  "agent-ingress",
])("does not turn %s input into an owner-authorized personal tool", async (kind) => {
  await fixture(async ({ tools, context, effects }) => {
    expect(context()).toBeDefined();
    expect(tools).toEqual([]);
    expect(effects).toEqual([]);
    if (kind === "non-admin") {
      expect(context()?.senderIsOwner).toBe(false);
      expect(context()?.requesterProfile?.id).toBe("profile-ada");
    } else {
      expect(context()?.requesterProfile).toBeUndefined();
    }
  }, kind);
});

it("does not lend the profile to a different factory target or an ambiguous turn", async () => {
  await fixture(async ({ construct, steer, context }) => {
    for (const target of [
      { runId: "other" },
      { sessionId: "other" },
      { agentSessionKey: "agent:main:other" },
    ]) {
      expect(construct(target)).toEqual([]);
      expect(context()?.requesterProfile).toBeUndefined();
    }
    expect(() => construct({ requesterAgentIdOverride: "other" })).toThrow("session key belongs");
    steer();
    expect(construct()).toEqual([]);
    expect(context()?.requesterProfile).toBeUndefined();
  });
});

it("rejects a retained personal tool invoked under a replacement run context", async () => {
  await fixture(async ({ tools, effects }) => {
    await expect(
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: attempt.sessionKey,
          sessionId: attempt.sessionId,
          operationalRunInstance: createOperationalRunInstanceRef("replacement"),
        },
        () => tools[1]!.execute("draft", {}),
      ),
    ).rejects.toThrow("requester profile is no longer current");
    expect(effects).toEqual([]);
  });
});
