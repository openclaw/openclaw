import { expect, it } from "vitest";
import {
  prepareSystemAgentRunAdmission,
  readAdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import { createTestOperatorAuthority } from "../admitted-run-context.test-support.js";
import { attachCompactionAccountingRecorder } from "../embedded-agent-runner/run/compaction-accounting-bridge.js";
import { captureContextEngineTurnOperatorSource } from "./context-engine-turn-authority.js";

it.each(["admission", "recorder"] as const)(
  "leaves ordinary operator maintenance model-only via %s without a recovery source",
  async (route) => {
    const authority = createTestOperatorAuthority({
      canonicalIdentity: null,
      profileId: "ordinary-owner",
      scopes: ["operator.admin"],
    });
    const preparation = prepareSystemAgentRunAdmission(
      {},
      "ordinary-maintenance",
      "main",
      "test",
      undefined,
      authority,
    );
    try {
      const admittedRunContext = await preparation.admit("embedded");
      const runtimeContext = {
        provider: "fixture",
        modelId: "model",
        operatorSource: { kind: "unavailable" },
      };
      if (route === "recorder") {
        attachCompactionAccountingRecorder(runtimeContext, {
          operatorAuthority: readAdmittedRunOperatorAuthority(admittedRunContext),
        });
      }
      expect(
        captureContextEngineTurnOperatorSource(
          runtimeContext,
          route === "admission" ? { admittedRunContext } : {},
        ),
      ).toBeUndefined();
    } finally {
      preparation.close();
    }
  },
);
