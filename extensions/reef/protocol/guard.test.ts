import { jsonResponse } from "openclaw/plugin-sdk/test-env";
import { assert, expect, it } from "vitest";
import {
  cancelTrackedTextResponse,
  createStreamingResponse,
} from "../../test-support/streaming-error-response.js";
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
const modelAllow = {
  decision: "allow",
  category: "coordination",
  reason: "Routine coordination.",
  policyVersion: "v1",
} as const;
const allow: Verdict = { ...modelAllow, model };
const failure = { decision: "deny", category: "guard_failure" };
const adapterOptions = { apiKey: "test", pinnedModel: model };
const openAiGuard = (fetch: FetchLike, rules?: GuardRules) =>
  createOpenAiGuard({ ...adapterOptions, fetch, rules });
const classifyEnvelope = (envelope: unknown) =>
  openAiGuard(async () => jsonResponse(envelope)).classify(request);
const classify = (verdict: unknown = modelAllow) => classifyEnvelope(openAiEnvelope(verdict));
const rawGuard = (pinnedModel: string) =>
  admitGuardAdapter({ providerId: "fake", pinnedModel, classifyRaw: async () => allow });
const expectFailure = (result: Promise<unknown>) => expect(result).resolves.toMatchObject(failure);

it.each([
  ["malformed", async () => "not an object"],
  ["extra fields", async () => ({ ...allow, extra: true })],
])("fails closed when raw adapter %s", async (_name, classifyRaw) => {
  const guard = admitGuardAdapter({ providerId: "fake", pinnedModel: model, classifyRaw });
  await expect(guard.classify(request)).resolves.toMatchObject({ ...failure, model });
});

it("fails closed on timeout", async () => {
  const guard = admitGuardAdapter(
    { providerId: "fake", pinnedModel: model, classifyRaw: () => new Promise(() => {}) },
    5,
  );
  await expectFailure(guard.classify(request));
});

it("rejects bare family aliases without a documented immutable id", () => {
  expect(() => rawGuard("gpt-5.6")).toThrow("dated snapshot");
});

it.each(["gpt-6.1-sol"])("accepts documented immutable undated id %s", (pinnedModel) => {
  expect(() => rawGuard(pinnedModel)).not.toThrow();
});

it("cancels Anthropic non-200 provider response bodies before failing closed", async () => {
  const { response, wasCanceled } = cancelTrackedTextResponse("error", { status: 503 });
  const guard = createAnthropicGuard({ ...adapterOptions, fetch: async () => response });

  await expectFailure(guard.classify(request));
  expect(wasCanceled()).toBe(true);
});

it("cancels oversized provider response streams before buffering them fully", async () => {
  const streamed = createStreamingResponse({
    chunkCount: 64,
    chunkSize: 64 * 1024,
  });
  await expectFailure(openAiGuard(async () => streamed.response).classify(request));
  expect(streamed.wasCanceled()).toBe(true);
  // Four 64 KiB chunks fit; allow the overflow chunk plus one queued chunk.
  expect(streamed.getReadCount()).toBeLessThanOrEqual(6);
});

it("fails closed on malformed JSON and provider model mismatch", async () => {
  await expectFailure(openAiGuard(async () => new Response("not json")).classify(request));
  await expectFailure(
    classifyEnvelope({ model: "other-model-2026-07-12", status: "completed", output: [] }),
  );
  await expectFailure(classify('{"decision":"deny",' + JSON.stringify(modelAllow).slice(1)));
});

it("takes model evidence from the provider and requires the model policy echo", async () => {
  await expectFailure(classify({ ...modelAllow, policyVersion: "v2" }));
  const { policyVersion: _policyVersion, ...missingPolicyJson } = modelAllow;
  await expectFailure(classify(missingPolicyJson));
  await expectFailure(classify({ ...modelAllow, model: "invented-2026-01-01" }));
});

const rules: GuardRules = {
  outbound: "Never mention Nightjar.",
  inbound: "Review shell commands.",
};

it.each(["outbound", "inbound"] as const)(
  "frames %s rules only as trusted instructions",
  async (direction) => {
    const fetch: FetchLike = async (_url, init) => {
      assert(typeof init?.body === "string", "expected serialized guard request");
      const body: { instructions?: string; system?: string; input?: string; messages?: unknown } =
        JSON.parse(init.body);
      const instructions = direction === "outbound" ? body.instructions : body.system;
      expect(instructions).toContain("<operator-policy>");
      expect(instructions).toContain(rules[direction]);
      const other = direction === "outbound" ? "inbound" : "outbound";
      expect(instructions).not.toContain(rules[other]);
      expect(body.input ?? JSON.stringify(body.messages)).not.toContain("Nightjar");
      return jsonResponse(
        direction === "outbound"
          ? openAiEnvelope()
          : {
              model,
              stop_reason: "end_turn",
              content: [{ type: "text", text: JSON.stringify(modelAllow) }],
            },
      );
    };
    const createGuard = direction === "outbound" ? createOpenAiGuard : createAnthropicGuard;
    await expect(
      createGuard({ ...adapterOptions, fetch, rules }).classify({ ...request, direction }),
    ).resolves.toEqual(allow);
  },
);

it("rejects blank or oversized rules at adapter construction", () => {
  const fetch: FetchLike = async () => jsonResponse(openAiEnvelope());
  for (const invalid of [{ outbound: "   " }, { inbound: "x".repeat(GUARD_RULES_MAX_CHARS + 1) }]) {
    expect(() => openAiGuard(fetch, invalid)).toThrow("guard rules");
    expect(() => createAnthropicGuard({ ...adapterOptions, fetch, rules: invalid })).toThrow(
      "guard rules",
    );
  }
});

it("binds rules text into the effective policy version", () => {
  expect(effectiveGuardPolicyVersion("v1")).toBe("v1");
  const withRules = effectiveGuardPolicyVersion("v1", rules);
  expect(withRules).toMatch(/^v1\+[0-9a-f]{64}$/);
  expect(effectiveGuardPolicyVersion("v1", { outbound: rules.outbound })).not.toBe(withRules);
  expect(effectiveGuardPolicyVersion("v1", { inbound: rules.outbound })).not.toBe(
    effectiveGuardPolicyVersion("v1", { outbound: rules.outbound }),
  );
});

function openAiEnvelope(verdict: unknown = modelAllow) {
  const text = typeof verdict === "string" ? verdict : JSON.stringify(verdict);
  return {
    model,
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  };
}
