import { expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  anthropicModel,
  registerParityHostLifecycle,
} from "../provider-transport-parity.test-support.js";
import * as unicode from "../utils/sanitize-unicode.js";
import {
  prepareSystemPrompt,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END,
} from "../utils/system-prompt-cache-boundary.js";
import { buildAnthropicRequest } from "./anthropic-messages.js";
import {
  applyAnthropicPayloadPolicyToParams,
  isAnthropicServerToolClearingEnabled,
  resolveAnthropicPayloadPolicy,
  resolveAnthropicEphemeralCacheControl,
  resolveAnthropicServerCompactionPlan,
} from "./anthropic-payload-policy.js";

const model = { provider: "anthropic", api: "anthropic-messages", contextWindow: 200_000 };
const direct = { ...model, id: "claude-sonnet-4-6", baseUrl: "https://api.anthropic.com/v1" };

registerParityHostLifecycle();

it("normalizes each live system revision and cache policy once without sharing editable blocks", async () => {
  const revisions = ["First 🦞", "Second"].map((prefix) =>
    prepareSystemPrompt(`${prefix}\ud800${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic`),
  );
  const sanitize = vi.spyOn(unicode, "sanitizeSurrogates");
  for (const round of [0, 1]) {
    for (const [index, revision] of revisions.entries()) {
      for (const cacheRetention of ["short", "long", "none"] as const) {
        const cache_control = {
          type: "ephemeral" as const,
          ...(cacheRetention === "long" ? { ttl: "1h" as const } : {}),
        };
        const prefix = index === 0 ? "First 🦞" : "Second";
        const expected =
          cacheRetention === "none"
            ? [{ type: "text", text: `${prefix}\nDynamic` }]
            : [
                { type: "text", text: prefix, cache_control },
                { type: "text", text: "Dynamic" },
              ];
        const { params } = await buildAnthropicRequest(
          anthropicModel,
          { systemPrompt: revision.text, preparedSystemPrompt: revision, messages: [] },
          { cacheRetention },
          "transport",
          true,
          false,
          `test-version-${round}`,
        );
        expect(JSON.stringify(params.system)).toBe(
          JSON.stringify([
            {
              type: "text",
              text: `x-anthropic-billing-header: cc_version=test-version-${round}; cc_entrypoint=sdk-cli;`,
            },
            { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
            ...expected,
          ]),
        );
        if (!Array.isArray(params.system)) {
          throw new Error("Expected editable system blocks");
        }
        const editableBlock = params.system[2];
        if (!editableBlock) {
          throw new Error("Expected the application system block");
        }
        editableBlock.text = "Payload hook edit";
        if (editableBlock.cache_control) {
          editableBlock.cache_control.ttl = "5m";
        }
        params.system.push({ type: "text", text: "Hook addition" });
      }
    }
  }
  expect(
    sanitize.mock.calls.filter(([text]) => revisions.some((revision) => revision.text === text)),
  ).toHaveLength(6);
  const { params } = await buildAnthropicRequest(
    anthropicModel,
    { systemPrompt: "Changed by wrapper", preparedSystemPrompt: revisions[0], messages: [] },
    { cacheRetention: "none" },
    "transport",
    false,
    false,
  );
  expect(params.system).toEqual([{ type: "text", text: "Changed by wrapper" }]);
});

it.each([
  ["https://us-east5-aiplatform.googleapis.com", { type: "ephemeral", ttl: "1h" }],
  ["https://proxy.example.test/vertex", { type: "ephemeral" }],
] as const)("gates env-configured long retention for %s", (baseUrl, expected) => {
  vi.stubEnv("OPENCLAW_CACHE_RETENTION", "long");
  expect(resolveAnthropicEphemeralCacheControl(baseUrl, undefined)).toEqual(expected);
});
it("uses the same host-resolved credential shape as the transport", () => {
  configureAiTransportHost({
    ...getAiTransportHost(),
    resolveSecretSentinel: () => "test-sk-ant-oat-fixture",
  });
  expect(
    resolveAnthropicServerCompactionPlan(
      model,
      { anthropicServerCompaction: true },
      "credential-sentinel",
    ),
  ).toEqual({ enabled: false });
});
it.each([
  { name: "OAuth credentials", model: direct, apiKey: "test-sk-ant-oat-fixture" },
  { name: "a proxy host", model: { ...direct, baseUrl: "https://proxy.example.test/v1" } },
])("stays off for $name", ({ model: requestModel, apiKey = "test-api-key" }) => {
  expect(resolveAnthropicServerCompactionPlan(requestModel, {}, apiKey)).toEqual({
    enabled: false,
  });
});

it("triggers inside a configured input cap", () => {
  expect(
    resolveAnthropicServerCompactionPlan(
      { ...direct, contextWindow: 1_000_000, contextTokens: 200_000 },
      {},
      "test-api-key",
    ),
  ).toEqual({ enabled: true, threshold: 140_000 });
});
it("requires resolved authentication before disabling client pruning", () => {
  expect(isAnthropicServerToolClearingEnabled(model, "  ")).toBe(false);
});

it.each([
  {
    tools: { allow: ["look*"], deny: ["exec*"] },
    excluded: ["exec_retired", "other_retired", "search"],
  },
  { tools: { deny: ["exec*"] }, excluded: ["exec_retired"] },
])("applies pruning filters to exposed and historical tools: $tools", ({ tools, excluded }) => {
  const payload: Record<string, unknown> = {
    tools: [{ name: "lookup" }, { name: "search" }],
    messages: [
      {
        role: "assistant",
        content: ["exec", "other", "lookup"].map((name) => ({
          type: "tool_use",
          id: `old_${name}`,
          name: `${name}_retired`,
          input: {},
        })),
      },
    ],
  };
  const policy = resolveAnthropicPayloadPolicy({ ...model, cacheTtlPruning: { tools } });
  applyAnthropicPayloadPolicyToParams(payload, policy, new Set());
  expect(payload.context_management).toEqual({
    edits: [expect.objectContaining({ type: "clear_tool_uses_20250919", exclude_tools: excluded })],
  });
});

it("lets a new session read the dynamic system text that precedes its Runtime facts", async () => {
  const cache_control = { type: "ephemeral" as const };
  const systemPrompt = (session: string) =>
    `Project context${SYSTEM_PROMPT_CACHE_BOUNDARY}## Tooling\nCall tools exactly.\n## Runtime${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY}Runtime: agent=main | session=${session}${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END}`;
  const build = async (session: string, messages: unknown[]) =>
    (
      await buildAnthropicRequest(
        anthropicModel,
        { systemPrompt: systemPrompt(session), messages } as never,
        { cacheRetention: "short" },
        "transport",
        false,
        false,
      )
    ).params;
  const user = { role: "user", content: "hello", timestamp: 0 };
  const shared = { type: "text", text: "## Tooling\nCall tools exactly.\n## Runtime" };

  // Opening request: the checkpoint sits before the session-owned Runtime facts, so the bytes it
  // covers are the same for every session, and one history checkpoint remains for the message.
  const [first, second] = await Promise.all([build("dm:a", [user]), build("dm:b", [user])]);
  expect(first.system).toEqual([
    { type: "text", text: "Project context", cache_control },
    { ...shared, cache_control },
    { type: "text", text: "Runtime: agent=main | session=dm:a" },
  ]);
  expect((second.system as unknown[]).slice(0, 2)).toEqual((first.system as unknown[]).slice(0, 2));
  expect(JSON.stringify(first.messages).split('"cache_control"')).toHaveLength(2);

  // Once the session has history, both history checkpoints return and the same blocks are sent
  // without the extra system checkpoint.
  const assistant = {
    role: "assistant",
    provider: anthropicModel.provider,
    api: "anthropic-messages",
    model: anthropicModel.id,
    stopReason: "stop",
    timestamp: 0,
    content: [{ type: "text", text: "hi" }],
  };
  const later = await build("dm:a", [user, assistant, { ...user, content: "again" }]);
  expect(later.system).toEqual([
    { type: "text", text: "Project context", cache_control },
    shared,
    { type: "text", text: "Runtime: agent=main | session=dm:a" },
  ]);
  expect(JSON.stringify(later.messages).split('"cache_control"')).toHaveLength(3);
});
