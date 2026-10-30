import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { prepareReplyToolAuthority } from "../auto-reply/reply/reply-tool-authority.js";
import { captureGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
import { materializeRequesterScopedMcpToolsForHarnessRun } from "../plugin-sdk/agent-harness-runtime.js";
import { createReplyOperation } from "../sessions/session-controller.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { disposeAllSessionMcpRuntimes } from "./agent-bundle-mcp-manager-api.js";
import {
  bindSessionMcpRuntimeTestScheduler,
  createSessionMcpRuntimeManager,
  makeManagerRuntime,
} from "./agent-bundle-mcp-manager.test-support.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import { createMcpRunView } from "./agent-bundle-mcp-run-view.js";
import {
  captureWebchatMcpRequester,
  type WebchatMcpRequesterContext,
} from "./agent-bundle-mcp-webchat-requester.js";
import { withPreparedEmbeddedRunToolAuthority } from "./harness/tool-authority.runtime.js";
import { admitted, attempt } from "./harness/tool-authority.runtime.test-support.js";
import { requesterMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { readMcpOAuthStore } from "./mcp-oauth-store.js";
import { withMcpOAuthTempHome } from "./mcp-oauth.test-harness.js";
import { prepareOperatorModelPolicy } from "./operator-model-policy.js";
import { closeProviderTransportDispatcherPool } from "./provider-transport-dispatcher-pool.js";

const oauth = vi.hoisted(() => ({ status: vi.fn(), start: vi.fn() }));
vi.mock("./mcp-oauth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-oauth.js")>()),
  readMcpOAuthCredentialsStatuses: oauth.status,
  startMcpOAuthAuthorization: oauth.start,
}));

const cfg = {
  gateway: { publicOrigin: "https://gateway.example" },
  mcp: {
    servers: {
      calendar: {
        url: "https://mcp.example/rpc",
        transport: "streamable-http" as const,
        auth: "oauth" as const,
        oauth: { identity: "per-requester" as const },
      },
    },
  },
};
let manager: ReturnType<typeof createSessionMcpRuntimeManager>;
beforeEach(() => {
  oauth.status.mockReset().mockResolvedValue([{ state: "unauthenticated" }]);
  oauth.start.mockReset().mockResolvedValue({
    status: "redirect",
    authorizationUrl: "https://auth.example/authorize?state=opaque",
  });
  manager = createSessionMcpRuntimeManager({
    createRuntime: (params) => makeManagerRuntime(params),
  });
});
afterEach(async () => {
  await manager.disposeAll();
  await disposeAllSessionMcpRuntimes();
});

async function withTurn<T>(
  profileId: string,
  run: (context: { turn: WebchatMcpRequesterContext; revoke: () => void }) => Promise<T>,
  turnKind: "visible" | "queued_followup" = "visible",
) {
  let revoked = false;
  const authority = createAdmittedRunOperatorAuthority({
    profileId,
    scopes: ["operator.read", "operator.write"],
    gatewayAccessGrant: null,
    modelPolicy: prepareOperatorModelPolicy({ cfg: {}, policy: {} }),
    assertCurrent() {
      if (revoked) {
        throw new Error("source revoked");
      }
    },
  });
  return admitted(async ({ admittedRunContext }) => {
    const input = {
      ...attempt,
      senderId: undefined,
      messageChannel: "webchat",
      gatewayUiCommandTarget: { connId: `${profileId}-connection`, profileId },
    };
    // Real chat.send owns a visible reply before its native backend is selected.
    const operation = createReplyOperation({
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      resetTriggered: false,
      turnKind,
    });
    await operation.bindToolAuthoritySnapshotAsync(
      prepareReplyToolAuthority({
        originatingChannel: "webchat",
        operatorAuthority: authority,
        run: { ...input, model: input.modelId },
      }),
    );
    const fingerprint = await operation.bindToolAuthorityRouteAsync({
      provider: input.provider,
      model: input.modelId,
    });
    try {
      return await withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext, replyOperation: operation },
        { ...input, toolAuthorityFingerprint: fingerprint },
        undefined,
        async (prepared) =>
          run({
            turn: { ...prepared, admittedRunContext },
            revoke: () => {
              revoked = true;
            },
          }),
      );
    } finally {
      operation.complete();
    }
  }, authority);
}

it("creates separate personal OAuth links for two people in the same Webchat session", async () => {
  const keys: string[] = [];
  for (const profileId of ["ada-profile", "grace-profile", "ada-profile"]) {
    await withTurn(profileId, async ({ turn }) => {
      const requester = captureWebchatMcpRequester(turn)!;
      expect(requester?.requesterSenderId).toBe(profileId);
      expect(turn.senderId).toBeUndefined();
      const acquisition = await manager.acquire({
        sessionId: turn.sessionId,
        sessionKey: turn.sessionKey,
        workspaceDir: "/workspace",
        cfg,
        requesterSenderId: requester.requesterSenderId,
        messageChannel: "webchat",
      });
      const view = await materializeBundleMcpToolsForRun({
        ...acquisition,
        assertRequesterCurrent: requester.assertCurrent,
      });
      try {
        expect(view.tools.map((tool) => tool.name)).toEqual(["calendar__connect"]);
        const result = await view.tools[0]!.execute("connect", {});
        expect(result.details).toMatchObject({ mcpConnect: { serverName: "calendar" } });
        const [identity, , options] = oauth.start.mock.lastCall!;
        expect(identity.principal).toBe("requester");
        expect(options.login).toEqual(
          expect.objectContaining({ assertCurrent: expect.any(Function) }),
        );
        keys.push(identity.storeKey);
      } finally {
        await view.dispose();
      }
    });
  }
  expect(keys[0]).not.toBe(keys[1]);
  expect(keys[0]).toBe(keys[2]);
});

it("refuses a retained connect executor after source revocation and after turn end", async () => {
  const retained = await withTurn("ada-profile", async ({ turn, revoke }) => {
    const requester = captureWebchatMcpRequester(turn)!;
    const acquisition = await manager.acquire({
      sessionId: turn.sessionId,
      sessionKey: turn.sessionKey,
      workspaceDir: "/workspace",
      cfg,
      requesterSenderId: requester.requesterSenderId,
      messageChannel: "webchat",
    });
    const view = await materializeBundleMcpToolsForRun({
      ...acquisition,
      assertRequesterCurrent: requester.assertCurrent,
    });
    const connect = view.tools[0]!;
    revoke();
    await expect(connect.execute("revoked", {})).rejects.toThrow();
    expect(oauth.start).not.toHaveBeenCalled();
    return { connect, dispose: view.dispose };
  });
  await expect(retained.connect.execute("ended", {})).rejects.toThrow();
  expect(oauth.start).not.toHaveBeenCalled();
  await retained.dispose();
});

it("keeps turn guards off cached runtimes and fences every MCP operation", async () => {
  let current = true;
  const assertion = () => {
    if (!current) {
      throw new Error("turn ended");
    }
  };
  const request = vi.fn(async () => {
    const check = captureGuardedFetchRequestAuthority();
    expect(check).toEqual(expect.any(Function));
    await Promise.resolve();
    check!();
    return {};
  });
  const runtime = makeManagerRuntime({ sessionId: "shared", workspaceDir: "/workspace" });
  for (const name of [
    "getCatalog",
    "callTool",
    "listTools",
    "listResources",
    "readResource",
    "listResourceTemplates",
    "listPrompts",
    "getPrompt",
  ] as const) {
    Object.assign(runtime, { [name]: request });
    const view = createMcpRunView(runtime, assertion);
    await Reflect.apply(view[name]!, view, []);
    current = false;
    await expect(Reflect.apply(view[name]!, view, [])).rejects.toThrow("turn ended");
    expect(runtime[name]).toBe(request);
    current = true;
  }
});

it("does not infer credential authority from a profile label or a different run", async () => {
  await withTurn("ada-profile", async ({ turn }) => {
    const missing = [
      { admittedRunContext: undefined },
      { replyOperation: undefined },
      { toolAuthorityFingerprint: undefined },
      { runId: "other-run" },
      { sessionId: "other-session" },
      { sessionKey: "agent:other:main" },
      { gatewayUiCommandTarget: { connId: "other", profileId: "grace-profile" } },
      { senderId: "telegram-person" },
      { messageChannel: "telegram" },
      { spawnedBy: "parent-run" },
      { trigger: "memory" },
      { controlOperation: {} },
      { scheduledToolPolicy: {} },
      { inputProvenance: { kind: "internal_system" as const } },
    ];
    for (const change of missing) {
      expect(captureWebchatMcpRequester({ ...turn, ...change })).toBeUndefined();
    }
    expect(() =>
      captureWebchatMcpRequester({
        ...turn,
        gatewayUiCommandTarget: {
          connId: "different-connection",
          profileId: "ada-profile",
        },
      })!.assertCurrent(),
    ).toThrow("matching live Webchat participant");
  });
});

it("materializes Codex personal connect through the SDK without exposing private admission state", async () => {
  await bindSessionMcpRuntimeTestScheduler();
  await withTurn("ada-profile", async ({ turn }) => {
    const params = {
      sessionId: turn.sessionId,
      sessionKey: turn.sessionKey,
      workspaceDir: "/workspace",
      cfg,
      messageChannel: "webchat",
      policyContext: { config: cfg, messageChannel: "webchat", operatorProfileId: "ada-profile" },
    };
    const tools = await materializeRequesterScopedMcpToolsForHarnessRun(params);
    expect(tools?.tools.map((tool) => tool.name)).toEqual(["calendar__connect"]);
    await tools!.tools[0]!.execute("codex-connect", {});
    expect(oauth.start).toHaveBeenCalledOnce();
    const connect = tools!.tools[0]!;
    const advertised = tools!.advertisedTools[0]!;
    await tools!.dispose();
    await expect(connect.execute("codex-released", {})).rejects.toThrow("released");
    await expect(advertised.execute("codex-advertised-released", {})).rejects.toThrow("released");
    expect(oauth.start).toHaveBeenCalledOnce();
  });
});

it("closes a released native view before its parent turn ends", async () => {
  await withTurn("ada-profile", async ({ turn }) => {
    const requester = captureWebchatMcpRequester(turn)!;
    const acquisition = await manager.acquire({
      sessionId: turn.sessionId,
      sessionKey: turn.sessionKey,
      workspaceDir: "/workspace",
      cfg,
      requesterSenderId: requester.requesterSenderId,
      messageChannel: "webchat",
    });
    const view = await materializeBundleMcpToolsForRun({
      ...acquisition,
      assertRequesterCurrent: requester.assertCurrent,
    });
    const connect = view.tools[0]!;
    await view.dispose();
    await expect(connect.execute("released", {})).rejects.toThrow("released");
    expect(oauth.start).not.toHaveBeenCalled();
    requester.assertCurrent();
  });
});

it.each([
  ["native", "revoked"],
  ["native", "steered"],
  ["harness", "revoked"],
  ["harness", "steered"],
] as const)(
  "blocks real %s OAuth discovery and persistence when the participant is %s during preparation",
  async (consumer, change) => {
    await withMcpOAuthTempHome(async () => {
      // Exercise the actual SDK, HTTP guard and SQLite writer; only the external
      // authorization server's first response is held at a deterministic boundary.
      const actual = await vi.importActual<typeof import("./mcp-oauth.js")>("./mcp-oauth.js");
      oauth.start.mockImplementation(actual.startMcpOAuthAuthorization);
      const started = createDeferred();
      const release = createDeferred();
      const paths: string[] = [];
      const server = await reserveTestPortListener({
        offsets: [0],
        createListener: () =>
          createServer((request, response) => {
            paths.push(request.url!);
            started.resolve();
            void release.promise.then(() => {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  resource: `${origin}/mcp`,
                  authorization_servers: [origin],
                }),
              );
            });
          }),
      });
      const origin = `http://127.0.0.1:${server.claim.port}`;
      const config = {
        ...cfg,
        mcp: { servers: { calendar: { ...cfg.mcp.servers.calendar, url: `${origin}/mcp` } } },
      };
      try {
        await withTurn("ada-profile", async ({ turn, revoke }) => {
          const requester = captureWebchatMcpRequester(turn)!;
          await bindSessionMcpRuntimeTestScheduler();
          const acquisition = await manager.acquire({
            sessionId: turn.sessionId,
            sessionKey: turn.sessionKey,
            workspaceDir: "/workspace",
            cfg: config,
            requesterSenderId: requester.requesterSenderId,
            messageChannel: "webchat",
          });
          const view =
            consumer === "native"
              ? await materializeBundleMcpToolsForRun({
                  ...acquisition,
                  assertRequesterCurrent: requester.assertCurrent,
                })
              : await materializeRequesterScopedMcpToolsForHarnessRun({
                  sessionId: turn.sessionId,
                  sessionKey: turn.sessionKey,
                  workspaceDir: "/workspace",
                  cfg: config,
                  messageChannel: "webchat",
                  policyContext: {
                    config,
                    messageChannel: "webchat",
                    operatorProfileId: "ada-profile",
                  },
                });
          expect(view).toBeDefined();
          try {
            const pending = view!.tools[0]!.execute("connect", {});
            const settled = pending.then(
              () => {
                throw new Error("Connect unexpectedly succeeded");
              },
              (error: unknown) => error,
            );
            await Promise.race([
              started.promise,
              settled.then((error) => {
                throw error;
              }),
            ]);
            if (change === "revoked") {
              revoke();
            } else {
              turn.replyOperation!.personalToolParticipants!.accept({
                operatorAuthority: createAdmittedRunOperatorAuthority({
                  profileId: "grace-profile",
                  scopes: ["operator.read", "operator.write"],
                  gatewayAccessGrant: null,
                  modelPolicy: prepareOperatorModelPolicy({ cfg: {}, policy: {} }),
                  assertCurrent() {},
                }),
                gatewayUiCommandTarget: { connId: "grace-connection", profileId: "grace-profile" },
              });
            }
            release.resolve();
            expect(await settled).toMatchObject({
              message: expect.stringContaining(
                change === "revoked"
                  ? "admitted run authority is no longer active"
                  : "Several people have steered",
              ),
            });
            expect(paths).toHaveLength(1);
            const identity = requesterMcpOAuthIdentity("calendar", `${origin}/mcp`, {
              requesterSenderId: "ada-profile",
              messageChannel: "webchat",
            });
            const stored = await readMcpOAuthStore(identity.storeKey);
            expect(stored.tokens).toBeUndefined();
            expect(stored.lastAuthorizationUrl).toBeUndefined();
            expect(stored.codeVerifier).toBeUndefined();
          } finally {
            await view!.dispose();
            if (consumer === "harness") {
              acquisition.releaseLease();
            }
          }
        });
      } finally {
        release.resolve();
        await closeProviderTransportDispatcherPool();
        await server.releaseListener();
        await server.claim.release();
      }
    }, "webchat-mcp-real-oauth-");
  },
);

it("does not borrow a person's credentials for a queued follow-up", async () => {
  await withTurn(
    "ada-profile",
    async ({ turn }) => {
      expect(captureWebchatMcpRequester(turn)).toBeUndefined();
    },
    "queued_followup",
  );
});
