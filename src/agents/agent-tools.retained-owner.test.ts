import { afterEach, assert, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { bindSessionRowProjection } from "../gateway/session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../gateway/session-row-projection.test-support.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
} from "./admitted-run-context.js";
import { createOpenClawCodingToolsInternalAsync } from "./agent-tools.js";
import {
  withGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";
import * as gatewayTransport from "./tools/gateway.js";
import * as scopedGateway from "./tools/in-process-gateway.js";
import { prepareSessionPortalToolTarget } from "./tools/session-portal-target.js";

// The real outer factory and gateway executor run; only Gateway I/O is fixed.
const request = vi
  .spyOn(gatewayTransport, "callGatewayTool")
  .mockResolvedValue({ marker: "protected-config-read" });
afterEach(() => request.mockClear());

it.each([
  "admin",
  "unowned",
  "narrow",
  "revoked",
  "policy-denied",
  "tainted",
  "tainted-later",
  "mobile_ui",
  "openclaw",
  "portal",
] as const)(
  "retained owner-only tool keeps sender attribution false and authorizes %s at effect",
  (state) =>
    withOpenClawTestState({ scenario: "minimal" }, async (fixture) => {
      const unsupported = state === "mobile_ui" || state === "openclaw" || state === "portal";
      const toolName = unsupported ? state : "gateway";
      const config = {
        tools: {
          profile: "full" as const,
          allow: [toolName],
          ...(state === "policy-denied" ? { deny: ["gateway"] } : {}),
        },
      };
      setRuntimeConfigSnapshot(config);
      const sessionKey = "agent:main:retained-owner-tool";
      const sessionId = "retained-owner-tool-session";
      replaceSessionEntrySync({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });
      const lifetime = new AbortController();
      let current = true;
      let tainted = state === "tainted";
      const authority =
        state === "unowned"
          ? undefined
          : createAdmittedRunOperatorAuthority({
              profileId: "authenticated-person",
              signal: lifetime.signal,
              scopes: state === "narrow" ? ["operator.write"] : ["operator.admin"],
              assertCurrent: () => {
                if (!current) {
                  throw new Error("Original operator grant revoked");
                }
              },
            });
      const context = createContext([], () => config);
      context.resolveGatewayContext = () => context;
      await withPluginRuntimeGatewayContextResolver(
        () => context,
        () =>
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey,
              operatorAuthority: authority,
              gatewayContextResolver: () => context,
            },
            async () => {
              const tools = await createOpenClawCodingToolsInternalAsync({
                config,
                agentId: "main",
                sessionKey,
                sessionId,
                workspaceDir: fixture.workspaceDir,
                senderIsOwner: false,
                trigger: "event",
                inputProvenance: { kind: "internal_system" },
                pluginExecutionAuthority: authority,
                isTurnTainted: () => tainted,
                toolConstructionPlan: {
                  includeBaseCodingTools: false,
                  includeShellTools: false,
                  includeChannelTools: false,
                  includeOpenClawTools: true,
                  includePluginTools: false,
                },
              });
              const gateway = tools.find((tool) => tool.name === toolName);
              if (state === "policy-denied") {
                expect(gateway).toBeUndefined();
                expect(request).not.toHaveBeenCalled();
                return;
              }
              assert(gateway);
              if (unsupported) {
                const dispatch = vi
                  .spyOn(scopedGateway, "callInProcessGatewayTool")
                  .mockResolvedValue({});
                try {
                  const args =
                    state === "mobile_ui"
                      ? { action: "observe" }
                      : state === "openclaw"
                        ? { message: "A retained operator is not a new owner sender." }
                        : { action: "list" };
                  const result = await gateway.execute("unsupported-owner-call", args);
                  expect(JSON.stringify(result)).toContain("gated");
                  expect(dispatch).not.toHaveBeenCalled();
                  expect(request).not.toHaveBeenCalled();
                } finally {
                  dispatch.mockRestore();
                }
                return;
              }
              expect(getGatewayToolCallerIdentity()?.operatorAuthority).toBe(authority);
              if (state === "revoked") {
                current = false;
                lifetime.abort(new Error("Original operator grant revoked"));
                expect(() => authority?.assertCurrent()).toThrow(/revoked/);
              }
              if (state === "tainted-later") {
                tainted = true;
              }
              const invoke = () =>
                gateway.execute("protected-owner-call", { action: "config.get" });
              if (state === "admin") {
                const result = await invoke();
                expect(JSON.stringify(result)).toContain("protected-config-read");
                expect(request).toHaveBeenCalledOnce();
              } else if (state === "revoked" || state === "tainted-later") {
                await expect(invoke()).rejects.toThrow(/revoked|tainted/);
                expect(request).not.toHaveBeenCalled();
              } else {
                const result = await invoke();
                expect(JSON.stringify(result)).toContain("gated");
                expect(request).not.toHaveBeenCalled();
              }
            },
          ),
      );
    }),
);

it.each(["sessions", "portal"] as const)(
  "retained non-admin keeps independently authorized %s execution through the real outer wrapper",
  (toolName) =>
    withOpenClawTestState({ scenario: "minimal" }, async (fixture) => {
      const config = { tools: { profile: "full" as const, allow: [toolName] } };
      setRuntimeConfigSnapshot(config);
      const identity = {
        agentId: "main",
        sessionKey: "agent:main:scoped-retained-tool",
        sessionId: "scoped-retained-session",
      };
      replaceSessionEntrySync(identity, { sessionId: identity.sessionId, updatedAt: 1 });
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "scoped-person",
        scopes: ["operator.sessions.write"],
        assertCurrent() {},
      });
      const context = createContext([], () => config);
      context.resolveGatewayContext = () => context;
      const lifetime = new AbortController();
      const binding = { ...identity, environmentId: "attached", ownerEpoch: 1, generation: 1 };
      const projection = createSessionRowProjectionFixture({
        cfg: config,
        store: { [identity.sessionKey]: { sessionId: identity.sessionId, updatedAt: 1 } },
      });
      bindSessionRowProjection(context, () => projection);
      Object.assign(context, {
        portalService: {},
        workerEnvironmentService: {
          getSessionAttachmentStatus: () => ({ attachment: binding }),
          captureSessionAttachment: () => ({
            binding,
            assertCurrent() {},
            touch: async () => {},
          }),
          get: () => ({ ...binding, leaseId: "lease", nodeDeviceId: "node", sharedHost: false }),
          getDedicatedNodeLeaseSignal: () => lifetime.signal,
        },
      });
      const sessionCall = vi.spyOn(scopedGateway, "callAgentToolGatewayRequest").mockResolvedValue({
        key: identity.sessionKey,
        owner: { actor: { type: "agent", id: "main", label: "scoped-session-effect" } },
      });
      const portalCall = vi
        .spyOn(scopedGateway, "callInProcessGatewayTool")
        .mockResolvedValue({ portals: [], marker: "scoped-portal-effect" });
      try {
        await withPluginRuntimeGatewayContextResolver(
          () => context,
          () =>
            withGatewayToolCallerIdentity(
              {
                agentId: identity.agentId,
                sessionKey: identity.sessionKey,
                operationalRunInstance: createOperationalRunInstanceRef("independent-scoped-run"),
                receiptAuthority: () => true,
                operatorAuthority: authority,
                gatewayContextResolver: () => context,
              },
              async () => {
                if (toolName === "portal") {
                  expect(prepareSessionPortalToolTarget(identity)).toBeDefined();
                }
                const tools = await createOpenClawCodingToolsInternalAsync({
                  ...identity,
                  config,
                  workspaceDir: fixture.workspaceDir,
                  senderIsOwner: false,
                  trigger: "event",
                  inputProvenance: { kind: "internal_system" },
                  pluginExecutionAuthority: authority,
                  toolConstructionPlan: {
                    includeBaseCodingTools: false,
                    includeShellTools: false,
                    includeChannelTools: false,
                    includeOpenClawTools: true,
                    includePluginTools: false,
                  },
                });
                const tool = tools.find((value) => value.name === toolName);
                assert(tool);
                const args =
                  toolName === "sessions"
                    ? {
                        action: "assign_owner",
                        sessionKey: identity.sessionKey,
                        ownerType: "agent",
                        ownerId: "main",
                      }
                    : { action: "list" };
                const result = await tool.execute("independent-scoped-effect", args);
                expect(JSON.stringify(result)).toContain(
                  toolName === "sessions" ? "scoped-session-effect" : "scoped-portal-effect",
                );
                if (toolName === "sessions") {
                  expect(sessionCall).toHaveBeenCalledOnce();
                } else {
                  expect(portalCall).toHaveBeenCalledOnce();
                }
              },
            ),
        );
      } finally {
        sessionCall.mockRestore();
        portalCall.mockRestore();
        lifetime.abort();
      }
    }),
);
