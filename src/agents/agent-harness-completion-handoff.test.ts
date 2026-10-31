import { describe, expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import {
  captureAgentHarnessCompletionCustody,
  registerAgentHarnessCompletionHandoff,
} from "./agent-harness-completion-custody.js";
import { createAgentHarnessCompletionScope } from "./agent-harness-completion-scope.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { settleRequesterRun } from "./requester-run-settlement.js";

const state = vi.hoisted(() => ({ currentInstance: undefined as unknown }));
vi.mock("../infra/agent-run-registry.js", () => ({
  getActiveAgentRunDelegatedAuthority: () => ({ operationalRunInstance: state.currentInstance }),
}));
vi.mock("../gateway/server-plugin-in-process-dispatch.js", () => ({
  captureOperatorToolGatewayContinuationContext: async () => ({
    signal: new AbortController().signal,
    run: <T>(fn: () => T) => fn(),
    assertCurrent() {},
    release() {},
  }),
}));
vi.mock("../process/gateway-work-admission.js", () => ({
  retainGatewayRootWorkAdmissionContinuationScope: () => undefined,
}));
// mock-isolation: Gateway execution tracking and requester storage are external IO;
// custody creation, ownership checks, acceptance registration, and settlement stay real.
vi.mock("../plugins/runtime/gateway-request-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/runtime/gateway-request-scope.js")>()),
  getInProcessGatewayRequestContext: () => ({
    trackExecution: async <T>(run: () => Promise<T>) => run(),
    logGateway: { warn: vi.fn() },
  }),
}));
vi.mock("./subagents/announce/subagent-announce-delivery.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./subagents/announce/subagent-announce-delivery.runtime.js")
  >()),
  captureRequesterSessionEntryCurrent: async () => ({
    readCurrent: () => ({ sessionId: "session", lifecycleRevision: "one" }),
    release() {},
  }),
  withSubagentRequesterSource: async <T>(
    _key: string,
    _agentId: string | undefined,
    consume: (isCurrent?: () => boolean) => Promise<T>,
  ) => consume(),
}));
vi.mock("./subagents/registry/subagent-registry.js", () => ({
  markRequesterTurnYielded: vi.fn(),
  settleRequesterAfterSessionSpawns: vi.fn(async () => true),
}));

async function fixture() {
  const admission = prepareSystemAgentRunAdmission({}, "requester", "main", "native-handoff-test");
  const instance = admission.operationalRunInstance;
  state.currentInstance = instance;
  let active = true;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("requester replaced");
    }
  };
  const scope = createAgentHarnessCompletionScope({
    requesterSessionKey: "agent:main:main",
    run: { instance, assertCurrent },
  });
  const custody = await captureAgentHarnessCompletionCustody(scope);
  if (!custody) {
    throw new Error("missing custody");
  }
  return {
    admission,
    instance,
    scope,
    custody,
    assertCurrent,
    revoke: () => {
      active = false;
    },
  };
}

describe("native completion handoff", () => {
  it.each([
    "accepted",
    "no-work",
    "aborted",
    "error",
    "implicit",
    "wrong-run",
    "released-after-acceptance",
    "revoked-after-acceptance",
  ] as const)(
    "settles only an explicit successful yield with host-owned acceptance: %s",
    async (kind) => {
      const f = await fixture();
      try {
        if (kind !== "no-work") {
          registerAgentHarnessCompletionHandoff({
            scope: f.scope,
            completionCustody: f.custody,
            runId: "native-child:turn-two",
          });
        }
        const result: EmbeddedAgentRunResult = {
          meta: {
            durationMs: 1,
            yielded: true,
            ...(kind === "aborted" ? { aborted: true } : {}),
            ...(kind === "error" ? { error: { kind: "incomplete_turn", message: "failed" } } : {}),
            ...(kind === "implicit" ? { continuationPending: true } : {}),
          },
        };
        if (kind === "released-after-acceptance") {
          f.custody.release();
        }
        if (kind === "revoked-after-acceptance") {
          f.revoke();
        }
        const admission =
          kind === "wrong-run"
            ? prepareSystemAgentRunAdmission({}, "requester", "main", "other-native-handoff-test")
            : f.admission;
        const instance = admission.operationalRunInstance;
        state.currentInstance = instance;
        await settleRequesterRun(
          {
            sessionKey: "agent:main:main",
            agentId: "main",
            runId: "requester",
            preparedRunAdmission: admission,
          },
          result,
          () => {},
        );
        expect(result.requesterContinuationSettled).toBe(kind === "accepted" ? true : undefined);
      } finally {
        f.custody.release();
      }
    },
  );
  it.each(["copied-scope", "wrong-requester", "released", "revoked"] as const)(
    "rejects invalid acceptance: %s",
    async (kind) => {
      const f = await fixture();
      try {
        if (kind === "released") {
          f.custody.release();
        }
        if (kind === "revoked") {
          f.revoke();
        }
        const scope =
          kind === "copied-scope"
            ? { ...f.scope }
            : kind === "wrong-requester"
              ? createAgentHarnessCompletionScope({ requesterSessionKey: "agent:other:main" })
              : f.scope;
        expect(() =>
          registerAgentHarnessCompletionHandoff({
            scope,
            completionCustody: f.custody,
            runId: "native-child:turn-two",
          }),
        ).toThrow();
      } finally {
        f.custody.release();
      }
    },
  );
});
