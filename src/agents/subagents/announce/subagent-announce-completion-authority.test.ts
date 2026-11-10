import { afterEach, expect, it, vi } from "vitest";
import type { createAgentTurnService } from "../../../gateway/agent-turn/agent-turn-service.js";
import { captureGatewayOperatorRunAuthority } from "../../../gateway/operator-run-authority.js";
import { runWithOperatorToolGatewayAuthority } from "../../../gateway/operator-tool-gateway-authority.js";
import type { GatewayRequestHandlerOptions } from "../../../gateway/server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { assertOperatorModelAllowed } from "../../admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../../operator-model-policy.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { runAnnounceAgentCall } from "./subagent-announce-completion-delivery.js";

const startTurn = vi.hoisted(() => vi.fn<ReturnType<typeof createAgentTurnService>["startTurn"]>());
// mock-isolation: exercise the real intake/authorization boundary without running a model turn.
vi.mock("../../../gateway/agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn, waitForTurn: vi.fn() }),
}));

afterEach(() => startTurn.mockReset());

it.each([true, false])(
  "admits a recorded completion independently of a retired caller only while its owner is current (%s)",
  async (ownerCurrent) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const effect = vi.fn(({ respond }: GatewayRequestHandlerOptions) =>
        respond(true, { ok: true }),
      );
      const context = createContext([["sessions.delete", "operator.write", "sessions", effect]]);
      const resolveGatewayContext = () => context;
      context.resolveGatewayContext = resolveGatewayContext;
      const client = createOperatorClient({
        profileName: "completed-requester",
        scopes: ["operator.write"],
      });
      const source = await captureGatewayOperatorRunAuthority({ client, context });
      expect(source).toBeDefined();
      if (!source) {
        throw new Error("Operator authority was not captured");
      }
      client.internal = { ...client.internal, operatorRunAuthority: source.authority };
      const sessionKey = "agent:main:completion-authority";
      const input = reserveSessionControllerSource(sessionKey, {
        policy: { mode: "followup" },
        target: captureSessionTarget({
          storeScope: "/synthetic/completion-authority",
          sessionKey,
          incarnation: "requester-incarnation",
        }),
        continuationCaller: {
          run: async (run) => {
            if (!ownerCurrent) {
              throw new Error("completion owner retired");
            }
            return await run();
          },
        },
      });
      startTurn.mockImplementation(async (request) => {
        request.assertAdmissionCurrent?.();
        expect(request.controllerInput).toBe(input);
        request.io.emitAcceptance([
          true,
          { runId: "completion-authority", status: "accepted" },
          undefined,
        ]);
        request.io.emitFinal([true, { runId: "completion-authority", status: "ok" }, undefined]);
      });
      // The original waiting turn has finished before the held child result arrives.
      source.release();
      expect(() => source.authority.assertCurrent()).toThrow(
        "operator execution authority is no longer active",
      );
      try {
        await withPluginRuntimeGatewayRequestScope(
          { context, resolveGatewayContext, client, isWebchatConnect: () => false },
          () =>
            withGatewayToolCallerIdentity(
              { agentId: "main", sessionKey, operatorAuthority: source.authority },
              () =>
                runWithOperatorToolGatewayAuthority(
                  {
                    operatorRunAuthority: source.authority,
                    scopes: source.authority.scopes,
                    signal: new AbortController().signal,
                  },
                  async () => {
                    const completion = runAnnounceAgentCall({
                      agentParams: {
                        sessionKey,
                        message: "Recorded child result",
                        idempotencyKey: "completion-authority",
                        inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
                      },
                      controllerInput: input,
                      privateCompletion: true,
                      expectFinal: true,
                      isExecutionAllowed: () => true,
                      resolveGatewayContext,
                    });
                    if (ownerCurrent) {
                      await expect(completion).resolves.toMatchObject({ status: "ok" });
                      expect(startTurn).toHaveBeenCalledOnce();
                    } else {
                      await expect(completion).rejects.toThrow("completion owner retired");
                      expect(startTurn).not.toHaveBeenCalled();
                    }
                    await expect(
                      dispatchGatewayMethodInProcess(
                        "sessions.delete",
                        { key: sessionKey },
                        { resolveGatewayContext },
                      ),
                    ).rejects.toThrow("operator execution authority is no longer active");
                    expect(effect).not.toHaveBeenCalled();
                  },
                ),
            ),
        );
      } finally {
        retireSessionControllerInput(input);
      }
    });
  },
);

it("preserves live ordinary requester authority and its independent model ceiling", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = createContext();
    const resolveGatewayContext = () => context;
    context.resolveGatewayContext = resolveGatewayContext;
    const client = createOperatorClient({
      profileName: "ordinary-requester",
      scopes: ["operator.write"],
    });
    const source = await captureGatewayOperatorRunAuthority({ client, context });
    if (!source) {
      throw new Error("Operator authority was not captured");
    }
    const modelPolicy = prepareOperatorModelPolicy({
      cfg: { agents: { defaults: { model: "custom/allowed" } } },
      policy: { allow: ["custom/allowed"] },
      manifestPlugins: [],
    });
    client.internal = { ...client.internal, operatorRunAuthority: source.authority };
    startTurn.mockImplementation(async (request) => {
      request.assertAdmissionCurrent?.();
      expect(getGatewayToolCallerIdentity()?.operatorAuthority === source.authority).toBe(true);
      expect(getGatewayToolCallerIdentity()?.modelPolicy).toBe(modelPolicy);
      expect(() =>
        assertOperatorModelAllowed(
          undefined,
          { provider: "custom", model: "forbidden" },
          getGatewayToolCallerIdentity()?.modelPolicy,
        ),
      ).toThrow("cannot use this model");
      request.io.emitAcceptance([
        true,
        { runId: "ordinary-requester", status: "accepted" },
        undefined,
      ]);
      request.io.emitFinal([true, { runId: "ordinary-requester", status: "ok" }, undefined]);
    });
    try {
      const result = await withPluginRuntimeGatewayRequestScope(
        { context, resolveGatewayContext, client, isWebchatConnect: () => false },
        () =>
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: "agent:main:ordinary-requester",
              operatorAuthority: source.authority,
              modelPolicy,
            },
            () =>
              runAnnounceAgentCall({
                agentParams: {
                  sessionKey: "agent:main:ordinary-requester",
                  message: "One-way reply",
                  idempotencyKey: "ordinary-requester",
                  inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
                },
                privateCompletion: true,
                expectFinal: true,
                isExecutionAllowed: () => true,
                resolveGatewayContext,
              }),
          ),
      );
      expect(result).toMatchObject({ status: "ok" });
    } finally {
      source.release();
    }
  });
});
