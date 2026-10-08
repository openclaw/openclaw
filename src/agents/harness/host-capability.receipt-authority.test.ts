import { afterEach, expect, it, vi } from "vitest";
import { prepareSessionSourceAuthority } from "../../config/sessions/session-source-authority.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";

afterEach(() => resetAgentRunRegistryForTest());

it("preserves prepared receipt refusal and lexical closure without rereading its source", async () => {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId: "prepared-receipt",
      agentId: "main",
      ingress: { kind: "system", boundary: "host-capability-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef("prepared-receipt"),
  });
  try {
    const admittedRunContext = await admission.admit("plugin-harness", "harness-prepared-receipt");
    const attempt = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "prepared-receipt",
      admittedRunContext,
    };
    let current = true;
    class PreparedReceipt {
      releases = 0;
      get checks() {
        return [];
      }
      assertCurrent() {
        return current;
      }
      release() {
        this.releases += 1;
      }
    }
    const source = new PreparedReceipt();
    const receipt = Object.assign(
      vi.fn(() => current),
      {
        prepareSessionSource: async () => source,
      },
    );
    const host = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:session-1",
        operationalRunInstance: attempt.admittedRunContext.operationalRunInstance,
        receiptAuthority: receipt,
      },
      () => createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" }),
    );
    try {
      expect(() => host.capabilities.assertActive()).not.toThrow();
      const prepared = await prepareSessionSourceAuthority(host.capabilities.assertActive);
      try {
        receipt.mockClear();
        expect(() => prepared.assertCurrent()).not.toThrow();
        current = false;
        expect(() => prepared.assertCurrent()).toThrow();
        expect(receipt).not.toHaveBeenCalled();
        current = true;
        host.close();
        expect(() => prepared.assertCurrent()).toThrow("no longer active");
      } finally {
        await prepared.release?.();
      }
      expect(source.releases).toBe(1);
    } finally {
      host.close();
    }
  } finally {
    admission.close();
  }
});
