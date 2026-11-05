import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/config.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import * as agentPreflight from "../../../gateway/agent-turn/agent-request-preflight.js";
import { WRITE_SCOPE } from "../../../gateway/method-scopes.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlers,
} from "../../../gateway/server-methods/types.js";
import {
  captureOperatorToolGatewayContinuationContext,
  dispatchGatewayMethodInProcess,
} from "../../../gateway/server-plugin-in-process-dispatch.js";
import { createContext as createGatewayContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { roleClient } from "../../../gateway/session-sharing.test-utils.js";
import {
  withPluginRuntimeGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { sendSubagentAnnounceDirectly } from "./subagent-announce-direct-delivery.js";

function createContext(handlers: GatewayRequestHandlers): GatewayRequestContext {
  return createGatewayContext(
    Object.entries(handlers).map(([name, handler]) => [name, WRITE_SCOPE, "test", handler]),
  );
}

describe("subagent announce Gateway instance dispatch", () => {
  it.each(["own", "foreign"] as const)(
    "delivers a public child completion with retained session scope only to an %s requester",
    async (owner) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = {
          session: { store: state.path("sessions.sqlite") },
          gateway: {
            roles: {
              default: "view",
              definitions: {
                view: {
                  agents: "*",
                  scopes: ["operator.sessions.write"],
                  sessions: { others: "write" },
                },
              },
            },
          },
        } satisfies OpenClawConfig;
        setRuntimeConfigSnapshot(cfg);
        const client = roleClient("view", "completion-owner");
        client.connect.scopes = ["operator.sessions.write"];
        const sessionKey = "agent:main:dashboard:completion-owner";
        const sessionId = "selected-parent";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey, storePath: cfg.session.store },
          {
            sessionId,
            updatedAt: 1,
            createdActor: {
              type: "human",
              source: "profile",
              id:
                owner === "own"
                  ? expectDefined(client.authenticatedUserProfile, "requester profile").profileId
                  : "another-owner",
            },
          },
        );
        // mock-isolation: Stop after real Gateway admission; model execution is outside this contract.
        const consumed = vi
          .spyOn(agentPreflight, "prepareAgentRequestPreflight")
          .mockImplementation(async ({ client: principal, request, io }) => {
            expect(principal?.connect.scopes).toEqual(["operator.sessions.write"]);
            expect(request.expectedExistingSessionId).toBe(sessionId);
            io.emitAcceptance([
              true,
              { status: "ok", result: { payloads: [{ text: "Child reviewed." }] } },
              undefined,
            ]);
            return undefined;
          });
        onTestFinished(() => consumed.mockRestore());
        const context = createGatewayContext([], () => cfg);
        const resolveGatewayContext = () => context;
        context.resolveGatewayContext = resolveGatewayContext;
        const retained = expectDefined(
          await withPluginRuntimeGatewayRequestScope(
            { client, context, resolveGatewayContext, isWebchatConnect: () => false },
            () => captureOperatorToolGatewayContinuationContext(),
          ),
          "retained requester authority",
        );
        try {
          const result = await retained.run(() =>
            sendSubagentAnnounceDirectly({
              requesterSessionKey: "agent:main:subagent:gone-requester",
              requesterAgentId: "main",
              targetRequesterSessionKey: sessionKey,
              completionRequesterSessionId: "gone-requester-session",
              sourceSessionKey: "agent:main:subagent:completed-child",
              sourceTool: "subagent_announce",
              triggerMessage: "Review the completed child.",
              expectsCompletionMessage: true,
              requesterIsSubagent: false,
              directIdempotencyKey: "public-completion-session-scope",
              resolveGatewayContext,
            }),
          );
          if (owner === "own") {
            expect(result).toMatchObject({ delivered: true, path: "direct" });
            expect(consumed).toHaveBeenCalledOnce();
          } else {
            expect(result.delivered).toBe(false);
            expect(result.error).toContain("Session-scoped writes require your own session");
            expect(consumed).not.toHaveBeenCalled();
          }
          expect(retained.scopes).toEqual(["operator.sessions.write"]);
        } finally {
          retained?.release();
        }
      });
    },
  );

  it("delivers through a lifecycle-fenced instance resolver scope", async () => {
    const context = createContext({
      agent: ({ respond }) => respond(true, { raw: true }),
    });
    const idempotencyKey = "scoped-subagent-announce";
    context.dedupe.set(`agent:${idempotencyKey}`, {
      ts: Date.now(),
      ok: true,
      payload: { runId: "scoped-announce-run", status: "ok", summary: "delivered" },
    });

    await expect(
      withPluginRuntimeGatewayContextResolver(
        () => context,
        () =>
          dispatchGatewayMethodInProcess(
            "agent",
            {
              message: "Process one completed child result.",
              idempotencyKey,
            },
            {
              expectFinal: true,
              forceSyntheticClient: true,
            },
          ),
      ),
    ).resolves.toEqual({
      runId: "scoped-announce-run",
      status: "ok",
      summary: "delivered",
    });
  });
  it("rejects a nested-wake owner retired after selection before either Gateway dispatches", async () => {
    const retiredAgent = vi.fn(({ respond }) => respond(true, { raw: true }));
    const retiredContext = createContext({ agent: retiredAgent });
    const replacementAgent = vi.fn(({ respond }) => respond(true, { raw: true }));
    const replacementContext = createContext({ agent: replacementAgent });
    const resolveGatewayContext = vi
      .fn<() => GatewayRequestContext | undefined>()
      .mockReturnValueOnce(retiredContext)
      .mockReturnValue(undefined);

    await expect(
      withPluginRuntimeGatewayContextResolver(
        () => replacementContext,
        () =>
          dispatchGatewayMethodInProcess(
            "agent",
            {
              message: "Continue after nested descendants settle.",
              idempotencyKey: "retired-nested-wake",
            },
            {
              forceSyntheticClient: true,
              resolveGatewayContext,
            },
          ),
      ),
    ).rejects.toThrow("current gateway instance binding");
    expect(resolveGatewayContext).toHaveBeenCalledTimes(2);
    expect(retiredAgent).not.toHaveBeenCalled();
    expect(replacementAgent).not.toHaveBeenCalled();
  });
});
