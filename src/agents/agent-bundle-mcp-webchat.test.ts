import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createReplyOperation } from "../sessions/session-controller.js";
import { testing as replyTesting } from "../sessions/session-controller.test-support.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { materializeRequesterScopedMcpToolsForHarnessRunCore } from "./agent-bundle-mcp-harness.js";
import {
  acquireSessionMcpRuntime,
  disposeAllSessionMcpRuntimes,
  setSessionMcpRuntimeScheduler,
} from "./agent-bundle-mcp-manager-api.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import {
  SESSION_MCP_RUNTIME_MANAGER_KEY,
  shouldLoadRequesterScopedMcpHarnessRuntime,
} from "./agent-bundle-mcp-runtime-shared.js";
import { withPreparedEmbeddedRunToolAuthority } from "./harness/tool-authority.runtime.js";
import {
  admitted,
  attempt,
  createDirectReplyOperation,
  sessionId,
  sessionKey,
} from "./harness/tool-authority.runtime.test-support.js";
import { prepareOperatorModelPolicy } from "./operator-model-policy.js";

const authorize = vi.hoisted(() => vi.fn());
vi.mock("./mcp-oauth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-oauth.js")>()),
  readMcpOAuthCredentialsStatuses: async () => [{ state: "unauthenticated" }],
  startMcpOAuthAuthorization: authorize,
}));

const cfg: OpenClawConfig = {
  gateway: { publicOrigin: "https://gateway.example.test" },
  mcp: {
    servers: {
      calendar: {
        transport: "streamable-http",
        url: "https://mcp.example.test",
        auth: "oauth",
        oauth: { identity: "per-requester" },
      },
    },
  },
};
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
beforeEach(async () => {
  Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
  scheduler = createTestGatewayScheduler();
  await setSessionMcpRuntimeScheduler(scheduler);
  authorize.mockReset().mockResolvedValue({
    status: "redirect",
    authorizationUrl: "https://identity.example.test/authorize",
  });
});
afterEach(async () => {
  await disposeAllSessionMcpRuntimes();
  await scheduler.stop();
  Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
  replyTesting.resetSessionControllerForTest();
});

it.each(["direct", "visible"] as const)(
  "connects browser profiles separately in %s turns and closes retained tools",
  async (turnKind) => {
    for (const profileId of ["alice", "bob", "alice"]) {
      const authority = createAdmittedRunOperatorAuthority({
        profileId,
        scopes: ["operator.read", "operator.write"],
        gatewayAccessGrant: null,
        modelPolicy: prepareOperatorModelPolicy({ cfg, policy: {} }),
        assertCurrent() {},
      });
      const connect = await admitted(
        async ({ admittedRunContext }) => {
          const replyOperation = createReplyOperation({
            sessionId,
            sessionKey,
            resetTriggered: false,
            turnKind,
          });
          return withPreparedEmbeddedRunToolAuthority(
            { admittedRunContext, replyOperation },
            {
              ...attempt,
              config: cfg,
              senderId: undefined,
              gatewayUiCommandTarget: { connId: `browser-${profileId}`, profileId },
            },
            undefined,
            async () => {
              const params = {
                sessionId,
                sessionKey,
                workspaceDir: "/synthetic/webchat",
                cfg,
                messageChannel: "webchat",
              };
              expect(shouldLoadRequesterScopedMcpHarnessRuntime(params)).toBe(true);
              const shared = await materializeBundleMcpToolsForRun(
                await acquireSessionMcpRuntime(params),
              );
              try {
                expect(shared.tools.some((tool) => tool.name === "calendar__connect")).toBe(false);
              } finally {
                await shared.dispose();
              }
              const view = await materializeRequesterScopedMcpToolsForHarnessRunCore(params);
              const tool = view?.tools.find((candidate) => candidate.name === "calendar__connect");
              expect(tool, "authenticated browser must have a personal connect tool").toBeDefined();
              try {
                const result = await tool!.execute("connect", {});
                expect(result.content).toEqual([
                  expect.objectContaining({
                    text: expect.stringContaining("https://identity.example.test/authorize"),
                  }),
                ]);
                return tool!;
              } finally {
                await view?.dispose();
              }
            },
          ).finally(() => replyOperation.complete());
        },
        authority,
        { config: cfg },
      );
      await expect(connect.execute("retained", {})).rejects.toThrow();
    }
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(expectDefined(authorize.mock.calls[0], "first authorization")[0]).toEqual(
      expectDefined(authorize.mock.calls[2], "repeat authorization")[0],
    );
    expect(expectDefined(authorize.mock.calls[0], "first authorization")[0]).not.toEqual(
      expectDefined(authorize.mock.calls[1], "second authorization")[0],
    );
  },
);

it.each(["anonymous", "wrong-profile", "memory", "other-session", "subagent"] as const)(
  "does not grant personal MCP to %s work",
  async (kind) => {
    const authority =
      kind === "anonymous"
        ? undefined
        : createAdmittedRunOperatorAuthority({
            profileId: "alice",
            scopes: ["operator.read", "operator.write"],
            gatewayAccessGrant: null,
            modelPolicy: prepareOperatorModelPolicy({ cfg, policy: {} }),
            assertCurrent() {},
          });
    await admitted(
      async ({ admittedRunContext }) => {
        await withPreparedEmbeddedRunToolAuthority(
          {
            admittedRunContext,
            replyOperation: createDirectReplyOperation(),
            ...(kind === "memory" ? { trigger: "memory" as const } : {}),
          },
          {
            ...attempt,
            config: cfg,
            senderId: undefined,
            ...(kind === "subagent" ? { spawnedBy: sessionKey } : {}),
            gatewayUiCommandTarget: {
              connId: "browser-alice",
              profileId: kind === "wrong-profile" ? "bob" : "alice",
            },
          },
          undefined,
          async () => {
            const params = {
              sessionId,
              sessionKey: kind === "other-session" ? "agent:main:other" : sessionKey,
              workspaceDir: "/synthetic/webchat",
              cfg,
              messageChannel: "webchat",
            };
            expect(shouldLoadRequesterScopedMcpHarnessRuntime(params)).toBe(false);
            const view = await materializeBundleMcpToolsForRun(
              await acquireSessionMcpRuntime(params),
            );
            try {
              expect(view.tools.some((tool) => tool.name === "calendar__connect")).toBe(false);
            } finally {
              await view.dispose();
            }
          },
        );
      },
      authority,
      { config: cfg },
    );
    expect(authorize).not.toHaveBeenCalled();
  },
);
