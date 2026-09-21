import { describe, expect, it, vi } from "vitest";
import { createInternalAgentTurnFacade } from "../../../gateway/agent-turn/internal-facade.js";
import { WRITE_SCOPE } from "../../../gateway/method-scopes.js";
import { createGatewayMethodRegistry } from "../../../gateway/methods/registry.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlers,
} from "../../../gateway/server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { withPluginRuntimeGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { trackAsyncWork } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { maybeSteerSubagentAnnounce } from "./subagent-announce-active-wake.js";
import {
  dispatchSubagentAnnounceAgent,
  setSubagentAnnounceDeliveryDepsForTest,
} from "./subagent-announce-delivery.runtime.js";
import { runSubagentAnnounceDispatch } from "./subagent-announce-dispatch.js";

function createContext(handlers: GatewayRequestHandlers): GatewayRequestContext {
  const context = {
    trackExecution: trackAsyncWork,
    deps: {},
    getRuntimeConfig: () => ({}),
    getGatewayMethodRegistry: () => createRegistry(handlers),
    logGateway: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
  context.createAgentTurnFacade = (principal) =>
    createInternalAgentTurnFacade({
      ...principal,
      getContext: () => context,
      getMethodRegistry: () => createRegistry(handlers),
    });
  return context;
}

function createRegistry(handlers: GatewayRequestHandlers) {
  return createGatewayMethodRegistry(
    Object.entries(handlers).map(([name, handler]) => ({
      name,
      handler,
      owner: { kind: "core" as const, area: "test" },
      scope: WRITE_SCOPE,
    })),
  );
}

describe("subagent announce Gateway instance dispatch", () => {
  it("delivers a detached announce through its explicit instance resolver", async () => {
    const context = createContext({
      agent: ({ respond }) => respond(true, { raw: true }),
    });
    const idempotencyKey = "detached-subagent-announce";
    context.dedupe.set(`agent:${idempotencyKey}`, {
      ts: Date.now(),
      ok: true,
      payload: { runId: "announce-run", status: "ok", summary: "delivered" },
    });

    await expect(
      dispatchSubagentAnnounceAgent(
        {
          message: "Process one completed child result.",
          idempotencyKey,
        },
        {
          expectFinal: true,
          forceSyntheticClient: true,
          resolveGatewayContext: () => context,
        },
      ),
    ).resolves.toEqual({ runId: "announce-run", status: "ok", summary: "delivered" });
  });

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
          dispatchSubagentAnnounceAgent(
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

    await withPluginRuntimeGatewayContextResolver(
      () => replacementContext,
      async () => {
        await expect(
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
        ).rejects.toThrow("current gateway instance binding");
      },
    );
    expect(resolveGatewayContext).toHaveBeenCalledTimes(2);
    expect(retiredAgent).not.toHaveBeenCalled();
    expect(replacementAgent).not.toHaveBeenCalled();
  });
});

describe("subagent announce active requester admission", () => {
  const requesterSessionKey = "agent:main:announce-requester";
  const sessionId = "announce-requester";
  const steerMessage = "Child task finished.";

  async function dispatchToRequester(
    handle: EmbeddedAgentQueueHandle,
    guards: {
      isSourceSessionAdmissionAllowed?: () => boolean;
      isSourceSessionEffectsAllowed?: () => boolean;
    },
  ) {
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));
    setSubagentAnnounceDeliveryDepsForTest({
      getRuntimeConfig: () => ({}),
      getRequesterSessionActivity: () => ({ sessionId, isActive: true }),
      loadRequesterSessionEntry: () => ({
        cfg: {},
        canonicalKey: requesterSessionKey,
        agentId: "main",
        entry: { sessionId, updatedAt: 1 },
      }),
    });
    try {
      setActiveEmbeddedRun(sessionId, handle, requesterSessionKey);
      const result = await runSubagentAnnounceDispatch({
        expectsCompletionMessage: false,
        steer: () => maybeSteerSubagentAnnounce({ requesterSessionKey, steerMessage, ...guards }),
        direct,
      });
      return { result, direct };
    } finally {
      clearActiveEmbeddedRun(sessionId, handle, requesterSessionKey);
      setSubagentAnnounceDeliveryDepsForTest();
    }
  }

  it.each([
    { name: "refuses source admission revoked during preparation", revoke: "before-injection" },
    {
      name: "keeps accepted delivery when source admission later closes",
      revoke: "after-injection",
    },
    {
      name: "retains the source effects fence after acceptance",
      revoke: "effects-after-injection",
    },
  ] as const)("$name", async ({ revoke }) => {
    const reachedBoundary = createDeferredCore();
    const continueDelivery = createDeferredCore();
    const injected: string[] = [];
    let admissionAllowed = true;
    let effectsAllowed = true;
    const handle = createEmbeddedRunHandle({ supportsTranscriptCommitWait: true });
    handle.messageInjectionV2 = {
      version: 2,
      isAvailable: () => true,
      queueMessage: async (text, _options, assertCurrent) => {
        if (revoke === "before-injection") {
          reachedBoundary.resolve();
          await continueDelivery.promise;
        }
        assertCurrent();
        injected.push(text);
        if (revoke !== "before-injection") {
          reachedBoundary.resolve();
          await continueDelivery.promise;
        }
      },
    };
    const delivery = dispatchToRequester(handle, {
      isSourceSessionAdmissionAllowed: () => admissionAllowed,
      isSourceSessionEffectsAllowed: () => effectsAllowed,
    });
    try {
      await Promise.race([
        reachedBoundary.promise,
        delivery.then(() => {
          throw new Error("Announcement settled before reaching V2 injection");
        }),
      ]);
      expect(injected).toEqual(revoke === "before-injection" ? [] : [steerMessage]);
      if (revoke === "effects-after-injection") {
        effectsAllowed = false;
      } else {
        admissionAllowed = false;
      }
      continueDelivery.resolve();
      const { result, direct } = await delivery;
      expect(injected).toEqual(revoke === "before-injection" ? [] : [steerMessage]);
      expect(direct).not.toHaveBeenCalled();
      expect(result).toMatchObject(
        revoke === "after-injection"
          ? { delivered: true, path: "steered" }
          : { delivered: false, path: "none", reason: "source_owner_changed", terminal: true },
      );
    } finally {
      continueDelivery.resolve();
      await delivery;
    }
  });

  it.each([false, true])(
    "routes announcements to a legacy requester with source admission guard=%s",
    async (guarded) => {
      const injected: string[] = [];
      const handle = createEmbeddedRunHandle({
        supportsTranscriptCommitWait: true,
        queueMessage: async (text) => {
          injected.push(text);
        },
      });
      const { result, direct } = await dispatchToRequester(
        handle,
        guarded ? { isSourceSessionAdmissionAllowed: () => true } : {},
      );

      expect(injected).toEqual(guarded ? [] : [steerMessage]);
      expect(direct).toHaveBeenCalledTimes(guarded ? 1 : 0);
      expect(result).toMatchObject({ delivered: true, path: guarded ? "direct" : "steered" });
    },
  );
});
