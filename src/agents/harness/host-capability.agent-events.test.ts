import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  emitAgentEvent,
  onAgentRuntimeEvent,
  type AgentEventRuntimePayload,
} from "../../infra/agent-events.js";
import {
  getAgentRunContext,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { getAdmittedRunDelegatedAuthority } from "../admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import {
  createHostAdmissionTestFixture,
  type HostRevocationContext,
} from "./host-capability.admission.test-support.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";

const { admittedAttempt, policyRevocations, closeAdmissions } = createHostAdmissionTestFixture();

function eventPublisher(host: ReturnType<typeof createAgentHarnessHostCapabilities>) {
  const publish = host.capabilities.publishAgentEvent;
  if (!publish) {
    throw new Error("expected the admitted host event publisher");
  }
  return publish;
}

afterEach(() => {
  closeAdmissions();
  resetAgentRunRegistryForTest();
});

describe("agent harness host event publication", () => {
  it("publishes under the captured private owner without invoking the optional observer", async () => {
    const observer = vi.fn();
    const { attempt } = await admittedAttempt("run-publication", { onAgentEvent: observer });
    const root = getAdmittedRunDelegatedAuthority(attempt.admittedRunContext);
    if (!root) {
      throw new Error("expected admitted authority");
    }
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const events: AgentEventRuntimePayload[] = [];
    const stop = onAgentRuntimeEvent((event) => events.push(event));
    try {
      attempt.runId = "forged-run";
      attempt.sessionKey = "forged-session";
      attempt.lifecycleGeneration = "forged-generation";
      const event = {
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
        runId: "forged-run",
        sessionKey: "forged-session",
        lifecycleGeneration: "forged-generation",
        contextClaimId: "forged-claim",
      };
      expect(eventPublisher(host)(event)).toBeUndefined();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        runId: "run-publication",
        sessionKey: "agent:main:session-1",
        contextClaimId: root.claimId,
        lifecycleGeneration: root.lifecycleGeneration,
        seq: 1,
        stream: "lifecycle",
        data: event.data,
      });
      expect(observer).not.toHaveBeenCalled();
      expect(getAgentRunContext("run-publication")?.lifecycleStartedAt).toBe(1_000);
      // A released plugin on the new host still owns its ordinary global + observer path.
      emitAgentEvent({ runId: "run-publication", stream: "tool", data: { phase: "start" } });
      expect(events[1]?.seq).toBe(2);
      expect(events[1]?.contextClaimId).toBeUndefined();
    } finally {
      stop();
      host.close();
    }
  });

  it.each([
    ...policyRevocations,
    {
      name: "outer admission closure",
      revoke: async ({ admission }: HostRevocationContext) => admission.close(),
    },
    {
      name: "lifecycle rotation",
      revoke: async () => {
        rotateAgentRunRegistryLifecycleGeneration();
      },
    },
  ])(
    "rejects event publication after $name without mutating the current run",
    async ({ revoke }) => {
      const { attempt, admission } = await admittedAttempt("run-event-revocation");
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      const publish = eventPublisher(host);
      const events: AgentEventRuntimePayload[] = [];
      const stop = onAgentRuntimeEvent((event) => events.push(event));
      try {
        publish({ stream: "tool", data: { phase: "start" } });
        await revoke({ host, attempt, admission });
        const context = getAgentRunContext(attempt.runId);
        const before = context && { ...context };
        expect(() =>
          publish({ stream: "lifecycle", data: { phase: "start", startedAt: 2_000 } }),
        ).toThrow("event publication is no longer active");
        expect(events).toHaveLength(1);
        expect(getAgentRunContext(attempt.runId)).toEqual(before);
      } finally {
        stop();
        host.close();
      }
    },
  );

  it.each(["attempt abort", "work scope closure"] as const)(
    "rejects publication after captured %s even if params replace the signal",
    async (reason) => {
      const work = new AsyncWorkScope();
      const controller = new AbortController();
      const { attempt } = await admittedAttempt("run-event-signal", {
        abortSignal: controller.signal,
      });
      const host = await work.track(() =>
        createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" }),
      );
      const publish = eventPublisher(host);
      const events: AgentEventRuntimePayload[] = [];
      const stop = onAgentRuntimeEvent((event) => events.push(event));
      try {
        if (reason === "attempt abort") {
          controller.abort();
        } else {
          work.beginClose();
        }
        attempt.abortSignal = new AbortController().signal;
        expect(() =>
          publish({ stream: "lifecycle", data: { phase: "start", startedAt: 1_000 } }),
        ).toThrow("event publication is no longer active");
        expect(events).toEqual([]);
        expect(getAgentRunContext(attempt.runId)?.lifecycleStartedAt).toBeUndefined();
      } finally {
        stop();
        host.close();
        await work.drain();
      }
    },
  );

  it.each(["gateway resolver", "source receipt"] as const)(
    "rechecks lexical closure after a reentrant %s returns normally",
    async (boundary) => {
      const { attempt } = await admittedAttempt("run-event-reentry");
      let closeDuringCheck: (() => void) | undefined;
      const close = () => closeDuringCheck?.();
      const context = {} as GatewayRequestContext;
      if (boundary === "gateway resolver") {
        bindGatewayContextResolver(attempt.admittedRunContext, () => {
          close();
          return context;
        });
      }
      const host = await withGatewayToolCallerIdentity(
        boundary === "source receipt"
          ? {
              agentId: "main",
              sessionKey: "agent:main:session-1",
              operationalRunInstance: attempt.admittedRunContext.operationalRunInstance,
              receiptAuthority: close,
            }
          : undefined,
        () => createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" }),
      );
      const publish = eventPublisher(host);
      const events: AgentEventRuntimePayload[] = [];
      const stop = onAgentRuntimeEvent((event) => events.push(event));
      try {
        closeDuringCheck = host.close;
        const lastActiveAt = getAgentRunContext(attempt.runId)?.lastActiveAt;
        expect(() =>
          publish({ stream: "lifecycle", data: { phase: "start", startedAt: 1_000 } }),
        ).toThrow("event publication is no longer active");
        expect(events).toEqual([]);
        expect(getAgentRunContext(attempt.runId)?.lifecycleStartedAt).toBeUndefined();
        expect(getAgentRunContext(attempt.runId)?.lastActiveAt).toBe(lastActiveAt);
        closeDuringCheck = undefined;
        const successor = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
        try {
          eventPublisher(successor)({ stream: "tool", data: { phase: "start" } });
          expect(events.map((event) => event.seq)).toEqual([1]);
        } finally {
          successor.close();
        }
      } finally {
        stop();
        host.close();
      }
    },
  );

  it("rejects source claim loss even while the admitted root remains active", async () => {
    const { attempt } = await admittedAttempt("run-event-source-loss");
    let sourceActive = true;
    const host = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:session-1",
        operationalRunInstance: attempt.admittedRunContext.operationalRunInstance,
        receiptAuthority: () => sourceActive,
      },
      () => createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" }),
    );
    const publish = eventPublisher(host);
    const events: AgentEventRuntimePayload[] = [];
    const stop = onAgentRuntimeEvent((event) => events.push(event));
    try {
      sourceActive = false;
      expect(getAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBeDefined();
      expect(() =>
        publish({ stream: "lifecycle", data: { phase: "start", startedAt: 1_000 } }),
      ).toThrow("event publication is no longer active");
      expect(events).toEqual([]);
      expect(getAgentRunContext(attempt.runId)?.lifecycleStartedAt).toBeUndefined();
    } finally {
      stop();
      host.close();
    }
  });

  it("does not relabel an accepted publication when its listener closes the host", async () => {
    const { attempt } = await admittedAttempt("run-event-listener-close");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const publish = eventPublisher(host);
    const stop = onAgentRuntimeEvent(() => host.close());
    try {
      expect(() => publish({ stream: "tool", data: { phase: "start" } })).not.toThrow();
      expect(() => publish({ stream: "tool", data: { phase: "result" } })).toThrow(
        "event publication is no longer active",
      );
    } finally {
      stop();
      host.close();
    }
  });
});
