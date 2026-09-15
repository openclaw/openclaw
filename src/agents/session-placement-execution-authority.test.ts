import { describe, expect, it } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  resolvePreparedRunActiveAssertion,
} from "./admitted-run-context.js";
import {
  installSessionPlacementAdmissionProvider,
  withSessionPlacementTurnAdmission,
} from "./session-placement-admission.js";

describe("placement execution authority", () => {
  it.each([false, true])(
    "keeps source recovery distinct from an open execution (closePrepared=%s)",
    async (closePrepared) => {
      const runId = "placement-execution-lifetime";
      const prepared = prepareAgentRunAdmission({
        cfg: {},
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        facts: {
          runId,
          agentId: "main",
          ingress: { kind: "system", state: "present", boundary: "test" },
        },
      });
      let retained: (() => void) | undefined;
      const uninstall = installSessionPlacementAdmissionProvider({
        assertCompactionSuccessorAllowed: () => {},
        executeLocalTurn: async (_claim, run) => run(),
        executeTurn: async (_claim, _params, _run, _admitted, assertSource, assertExecution) => {
          if (!assertExecution) {
            throw new Error("execution assertion was not supplied");
          }
          retained = assertExecution;
          assertExecution();
          if (closePrepared) {
            prepared.close();
            expect(assertSource).not.toThrow();
            expect(assertExecution).toThrow(/execution authority.*no longer active/);
          }
          return { meta: { durationMs: 0 } };
        },
      });
      try {
        await withSessionPlacementTurnAdmission(
          { sessionId: "session", sessionKey: "agent:main:session", agentId: "main", runId },
          {
            sessionId: "session",
            sessionKey: "agent:main:session",
            agentId: "main",
            runId,
            sessionFile: "agent:main:session",
            workspaceDir: "/unused",
            prompt: "test",
            timeoutMs: 1000,
            preparedRunAdmission: prepared,
          },
          async () => ({ meta: { durationMs: 0 } }),
        );
        if (!retained) {
          throw new Error("missing retained assertion");
        }
        expect(retained).toThrow(/execution authority.*no longer active/);
        expect(() => prepared.assertSourceCurrent()).not.toThrow();
      } finally {
        prepared.close();
        uninstall();
      }
    },
  );

  it("does not infer preparation authority from a copied structural carrier", () => {
    const prepared = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef("unforgeable-preparation"),
      facts: {
        runId: "unforgeable-preparation",
        agentId: "main",
        ingress: { kind: "system", state: "present", boundary: "test" },
      },
    });
    const assertActive = resolvePreparedRunActiveAssertion(prepared);
    expect(assertActive).toBeTypeOf("function");
    expect(resolvePreparedRunActiveAssertion({ ...prepared })).toBeUndefined();
    prepared.close();
    expect(assertActive).toThrow(/no longer active/);
    expect(() => prepared.assertSourceCurrent()).not.toThrow();
  });
});
