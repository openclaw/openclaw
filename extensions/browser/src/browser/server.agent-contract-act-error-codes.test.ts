import { describe, expect, it } from "vitest";
import {
  installAgentContractHooks,
  postJson,
  startServerAndBase,
} from "./server.agent-contract.test-harness.js";
import { setBrowserControlServerEvaluateEnabled } from "./server.control-server.test-harness.js";

type ActErrorResponse = {
  error?: string;
  code?: string;
};

describe("browser control server", () => {
  installAgentContractHooks();

  const slowTimeoutMs = process.platform === "win32" ? 40_000 : 20_000;

  it(
    "returns ACT_INVALID_REQUEST for malformed action payloads",
    async () => {
      const base = await startServerAndBase();
      const response = await postJson<ActErrorResponse>(`${base}/act`, {
        kind: "click",
        ref: {},
      });

      expect(response.code).toBe("ACT_INVALID_REQUEST");
      expect(response.error).toContain("click requires ref or selector");
    },
    slowTimeoutMs,
  );

  it(
    "returns ACT_TARGET_ID_MISMATCH for batched action targetId overrides",
    async () => {
      const base = await startServerAndBase();
      const response = await postJson<ActErrorResponse>(`${base}/act`, {
        kind: "batch",
        actions: [{ kind: "click", ref: "5", targetId: "other-tab" }],
      });

      expect(response.code).toBe("ACT_TARGET_ID_MISMATCH");
      expect(response.error).toContain("batched action targetId must match request targetId");
    },
    slowTimeoutMs,
  );

  it(
    "returns ACT_SELECTOR_UNSUPPORTED for selector on unsupported action kinds",
    async () => {
      const base = await startServerAndBase();
      const response = await postJson<ActErrorResponse>(`${base}/act`, {
        kind: "evaluate",
        fn: "() => 1",
        selector: "#submit",
      });

      expect(response.code).toBe("ACT_SELECTOR_UNSUPPORTED");
      expect(response.error).toContain("'selector' is not supported");
    },
    slowTimeoutMs,
  );

  it(
    "returns ACT_EVALUATE_DISABLED when evaluate is blocked by config",
    async () => {
      setBrowserControlServerEvaluateEnabled(false);
      const base = await startServerAndBase();
      const response = await postJson<ActErrorResponse>(`${base}/act`, {
        kind: "evaluate",
        fn: "() => 1",
      });

      expect(response.code).toBe("ACT_EVALUATE_DISABLED");
      expect(response.error).toContain("browser.evaluateEnabled=false");
    },
    slowTimeoutMs,
  );
});
