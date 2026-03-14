import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { VerdictClient } from "./client.js";
import type { ActionRequest, PolicyDecision } from "./types.js";

describe("VerdictClient", () => {
  const baseUrl = "http://localhost:8080";
  let client: VerdictClient;

  beforeEach(() => {
    client = new VerdictClient({ gatewayUrl: baseUrl, timeoutMs: 2000 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockFetch = (response: unknown, status = 200) => {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
      text: async () => JSON.stringify(response),
    } as Response);
  };

  describe("evaluate", () => {
    const request: ActionRequest = {
      action_id: "test-1",
      agent_id: "agent-1",
      tool: "issue_refund",
      args: { amount: 350, customer_id: "C-123" },
      context: {
        principal: "operator",
        agent_role: "L1_support",
        session_id: "sess-1",
        identity_verified: true,
      },
      timestamp: "2026-03-12T00:00:00Z",
    };

    it("sends POST to /evaluate and returns decision", async () => {
      const decision: PolicyDecision = {
        decision: "ALLOW",
        eval_duration_ms: 3.2,
        audit: {
          eval_id: "eval-1",
          bundle_digest: "sha256:abc",
          input_hash: "sha256:def",
          timestamp: "2026-03-12T00:00:00Z",
          shadow_mode: false,
        },
      };
      const spy = mockFetch(decision);

      const result = await client.evaluate(request);

      expect(result.decision).toBe("ALLOW");
      expect(spy).toHaveBeenCalledWith(
        `${baseUrl}/evaluate`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(request),
        }),
      );
    });

    it("appends ?shadow=true when shadow mode requested", async () => {
      const decision: PolicyDecision = {
        decision: "ALLOW",
        eval_duration_ms: 1.0,
        audit: {
          eval_id: "eval-2",
          bundle_digest: "sha256:abc",
          input_hash: "sha256:def",
          timestamp: "2026-03-12T00:00:00Z",
          shadow_mode: true,
        },
      };
      const spy = mockFetch(decision);

      await client.evaluate(request, true);

      expect(spy).toHaveBeenCalledWith(`${baseUrl}/evaluate?shadow=true`, expect.anything());
    });

    it("throws on non-ok response", async () => {
      mockFetch({ error: "bad request" }, 400);

      await expect(client.evaluate(request)).rejects.toThrow("Verdict POST");
    });
  });

  describe("health", () => {
    it("fetches gateway health", async () => {
      mockFetch({
        status: "ok",
        bundle_digest: "sha256:abc",
        eval_count: 42,
        p50_ms: 3.5,
        p99_ms: 12.0,
        shadow_mode: false,
      });

      const health = await client.health();

      expect(health.status).toBe("ok");
      expect(health.eval_count).toBe(42);
    });
  });

  describe("listPolicies", () => {
    it("fetches policy discovery", async () => {
      mockFetch({
        bundle_digest: "sha256:abc",
        policy_count: 2,
        policies: [
          { name: "refund-approval", source: "yaml", tools: ["issue_refund"] },
          { name: "pii-redaction", source: "rego", tools: ["*"] },
        ],
      });

      const discovery = await client.listPolicies();

      expect(discovery.policy_count).toBe(2);
      expect(discovery.policies[0].name).toBe("refund-approval");
    });
  });

  describe("tracesSummary", () => {
    it("passes since parameter", async () => {
      const spy = mockFetch({
        time_range: { from: "2026-03-11", to: "2026-03-12" },
        total_evaluations: 100,
        decisions: {},
      });

      await client.tracesSummary("1h");

      expect(spy).toHaveBeenCalledWith(`${baseUrl}/traces/summary?since=1h`, expect.anything());
    });
  });

  it("strips trailing slash from gatewayUrl", () => {
    const c = new VerdictClient({ gatewayUrl: "http://localhost:8080/" });
    // Access internal state via evaluate call
    const spy = mockFetch({ decision: "ALLOW", eval_duration_ms: 0, audit: {} });
    c.health();
    expect(spy).toHaveBeenCalledWith("http://localhost:8080/health", expect.anything());
  });
});
