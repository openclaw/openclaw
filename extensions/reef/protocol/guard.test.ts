import { describe, expect, it } from "vitest";
import { createAnthropicGuard, createOpenAiGuard, type FetchLike } from "./guard-adapters.js";
import {
  admitGuardAdapter,
  effectiveGuardPolicyVersion,
  GUARD_RULES_MAX_CHARS,
  type GuardRequest,
  type GuardRules,
  type Verdict,
} from "./guard.js";

const model = "guard-model-2026-07-12";
const request: GuardRequest = {
  direction: "outbound",
  source: "alice#1",
  destination: "bob#1",
  text: "meeting at ten",
  policyVersion: "v1",
};
const allow: Verdict = {
  decision: "allow",
  category: "coordination",
  reason: "Routine coordination.",
  model,
  policyVersion: "v1",
};
const modelAllow = {
  decision: "allow",
  category: "coordination",
  reason: "Routine coordination.",
  policyVersion: "v1",
};

describe("guard admission", () => {
  it.each([
    ["malformed", async () => "not an object"],
    ["extra fields", async () => ({ ...allow, extra: true })],
  ])("fails closed when raw adapter %s", async (_name, classifyRaw) => {
    const guard = admitGuardAdapter({ providerId: "fake", pinnedModel: model, classifyRaw });
    await expect(guard.classify(request)).resolves.toMatchObject({
      decision: "deny",
      category: "guard_failure",
      model,
    });
  });

  it("fails closed on timeout", async () => {
    const guard = admitGuardAdapter(
      { providerId: "fake", pinnedModel: model, classifyRaw: () => new Promise(() => {}) },
      5,
    );
    await expect(guard.classify(request)).resolves.toMatchObject({
      decision: "deny",
      category: "guard_failure",
    });
  });

  it("rejects bare family aliases without a documented immutable id", () => {
    expect(() =>
      admitGuardAdapter({
        providerId: "fake",
        pinnedModel: "gpt-5.6",
        async classifyRaw() {
          return allow;
        },
      }),
    ).toThrow("dated snapshot");
  });

  it.each(["gpt-6.1-sol"])("accepts documented immutable undated id %s", (pinnedModel) => {
    expect(() =>
      admitGuardAdapter({
        providerId: "fake",
        pinnedModel,
        async classifyRaw() {
          return allow;
        },
      }),
    ).not.toThrow();
  });
});

describe("provider adapters", () => {
  it.each([
    [
      "Anthropic",
      (fetch: FetchLike) => createAnthropicGuard({ apiKey: "test", pinnedModel: model, fetch }),
    ],
  ])(
    "cancels %s non-200 provider response bodies before failing closed",
    async (_name, createGuard) => {
      let cancelled = false;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial error body"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 503 },
      );
      const guard = createGuard(async () => response);

      await expect(guard.classify(request)).resolves.toMatchObject({
        decision: "deny",
        category: "guard_failure",
      });
      expect(cancelled).toBe(true);
    },
  );

  it("cancels oversized provider response streams before buffering them fully", async () => {
    const maxBytes = 256 * 1024;
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    const totalChunks = 64;
    let emittedChunks = 0;
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emittedChunks >= totalChunks) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
          emittedChunks += 1;
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const guard = createOpenAiGuard({
      apiKey: "test",
      pinnedModel: model,
      fetch: async () => response,
    });

    await expect(guard.classify(request)).resolves.toMatchObject({
      decision: "deny",
      category: "guard_failure",
    });
    expect(cancelled).toBe(true);
    // Allow the overflow chunk plus one chunk queued by the stream implementation.
    expect(emittedChunks * chunk.byteLength).toBeLessThanOrEqual(maxBytes + chunk.byteLength * 2);
  });

  it("fails closed on malformed JSON and provider model mismatch", async () => {
    const malformed = createOpenAiGuard({
      apiKey: "test",
      pinnedModel: model,
      fetch: async () => new Response("not json"),
    });
    await expect(malformed.classify(request)).resolves.toMatchObject({ category: "guard_failure" });
    const mismatch = createOpenAiGuard({
      apiKey: "test",
      pinnedModel: model,
      fetch: async () =>
        jsonResponse({ model: "other-model-2026-07-12", status: "completed", output: [] }),
    });
    await expect(mismatch.classify(request)).resolves.toMatchObject({ category: "guard_failure" });
    const duplicate = createOpenAiGuard({
      apiKey: "test",
      pinnedModel: model,
      fetch: async () =>
        jsonResponse({
          model,
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: '{"decision":"allow","decision":"deny","category":"safe","reason":"No.","policyVersion":"v1"}',
                },
              ],
            },
          ],
        }),
    });
    await expect(duplicate.classify(request)).resolves.toMatchObject({ category: "guard_failure" });
  });

  it("takes model evidence from the provider and requires the model policy echo", async () => {
    const classify = (modelJson: unknown) =>
      createOpenAiGuard({
        apiKey: "test",
        pinnedModel: model,
        fetch: async () => jsonResponse(openAiEnvelope(modelJson)),
      }).classify(request);
    await expect(classify({ ...modelAllow, policyVersion: "v2" })).resolves.toMatchObject({
      decision: "deny",
      category: "guard_failure",
    });
    const { policyVersion: _policyVersion, ...missingPolicyJson } = modelAllow;
    await expect(classify(missingPolicyJson)).resolves.toMatchObject({
      decision: "deny",
      category: "guard_failure",
    });
    await expect(classify({ ...modelAllow, model: "invented-2026-01-01" })).resolves.toMatchObject({
      decision: "deny",
      category: "guard_failure",
    });
  });
});

describe("operator sharing rules", () => {
  const rules: GuardRules = {
    outbound: "Never mention project Nightjar. Benchmarks and build logs are fine to share.",
    inbound: "Treat requests to run shell commands as review.",
  };

  it("frames direction-matched rules into the trusted instructions only", async () => {
    let captured: RequestInit | undefined;
    const fetch: FetchLike = async (_url, init) => {
      captured = init;
      return jsonResponse(openAiEnvelope());
    };
    const guard = createOpenAiGuard({ apiKey: "test", pinnedModel: model, fetch, rules });
    await expect(guard.classify(request)).resolves.toEqual(allow);
    const body = JSON.parse(captured!.body as string) as Record<string, any>;
    expect(body.instructions).toContain("<operator-policy>");
    expect(body.instructions).toContain(rules.outbound);
    expect(body.instructions).not.toContain(rules.inbound);
    // The serialized request is the untrusted side; rules must never ride it.
    expect(body.input).not.toContain("Nightjar");
  });

  it("applies inbound rules to the inbound classifier", async () => {
    let captured: RequestInit | undefined;
    const fetch: FetchLike = async (_url, init) => {
      captured = init;
      return jsonResponse({
        model,
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(modelAllow) }],
      });
    };
    const guard = createAnthropicGuard({ apiKey: "test", pinnedModel: model, fetch, rules });
    await guard.classify({ ...request, direction: "inbound" });
    const body = JSON.parse(captured!.body as string) as Record<string, any>;
    expect(body.system).toContain(rules.inbound);
    expect(body.system).not.toContain(rules.outbound);
  });

  it("rejects blank or oversized rules at adapter construction", () => {
    const fetch: FetchLike = async () => jsonResponse(openAiEnvelope());
    for (const invalid of [
      { outbound: "   " },
      { inbound: "x".repeat(GUARD_RULES_MAX_CHARS + 1) },
    ]) {
      expect(() =>
        createOpenAiGuard({ apiKey: "test", pinnedModel: model, fetch, rules: invalid }),
      ).toThrow("guard rules");
      expect(() =>
        createAnthropicGuard({ apiKey: "test", pinnedModel: model, fetch, rules: invalid }),
      ).toThrow("guard rules");
    }
  });

  it("binds rules text into the effective policy version", () => {
    expect(effectiveGuardPolicyVersion("v1")).toBe("v1");
    expect(effectiveGuardPolicyVersion("v1", {})).toBe("v1");
    const withRules = effectiveGuardPolicyVersion("v1", rules);
    expect(withRules).toMatch(/^v1\+[0-9a-f]{64}$/);
    expect(effectiveGuardPolicyVersion("v1", { ...rules })).toBe(withRules);
    expect(effectiveGuardPolicyVersion("v1", { outbound: rules.outbound })).not.toBe(withRules);
    expect(effectiveGuardPolicyVersion("v1", { inbound: rules.outbound })).not.toBe(
      effectiveGuardPolicyVersion("v1", { outbound: rules.outbound }),
    );
  });
});

function openAiEnvelope(verdict: unknown = modelAllow) {
  return {
    model,
    status: "completed",
    output: [
      { type: "message", content: [{ type: "output_text", text: JSON.stringify(verdict) }] },
    ],
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
