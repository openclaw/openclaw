import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveMemoryAudienceFromEntry } from "../plugins/memory-audience.js";
import { fakeSessionOwner } from "../plugins/memory-audience.test-support.js";
import {
  resolveOpenClawPluginToolInputs,
  type OpenClawPluginToolOptions,
} from "./openclaw-tools.plugin-context.js";

vi.mock("../config/sessions/session-delivery-generation.js", async () => {
  const { fakeSessionGenerationModule } =
    await import("../plugins/memory-audience.test-support.js");
  return fakeSessionGenerationModule;
});

function resolve(options: OpenClawPluginToolOptions) {
  return resolveOpenClawPluginToolInputs({
    options: { config: {}, ...options },
    resolvedConfig: options.config,
  }).context;
}

it("forwards one host-minted memory audience and its currency assertion", async () => {
  const sessionId = randomUUID();
  const sessionKey = "agent:main:direct:owner";
  const entry = { sessionId, updatedAt: 1, chatType: "direct" as const };
  fakeSessionOwner.rows.set(sessionKey, entry);
  const resolution = await resolveMemoryAudienceFromEntry(
    {
      agentId: "main",
      sessionKey,
      sessionId,
      senderIsOwner: true,
      storePath: "/tmp/openclaw-tools/main.sqlite",
    },
    entry,
  );
  const memoryAudience = resolution.status === "granted" ? resolution.audience : undefined;
  expect(memoryAudience).toBeDefined();
  const result = resolve({ memoryAudience, agentSessionKey: sessionKey });

  expect(result.memoryAudience).toBe(memoryAudience);
  result.assertMemoryAudienceCurrent!();
  expect(() => resolve({ memoryAudience, agentSessionKey: "agent:main:other" })).toThrow(
    "memory audience is bound to a different session",
  );
});

it.each([
  [" local ", " model ", "local", "model", "local/model"],
  ["openrouter", "openrouter/auto", "openrouter", "openrouter/auto", "openrouter/auto"],
])(
  "normalizes active model metadata for %s/%s",
  (modelProvider, inputId, provider, modelId, modelRef) => {
    expect(resolve({ modelProvider, modelId: inputId }).activeModel).toStrictEqual({
      provider,
      modelId,
      modelRef,
    });
  },
);

it("uses requester agent override for synthetic embedded session keys", () => {
  const recallWorkspace = path.join(process.cwd(), "tmp-recall-workspace");
  const config = {
    agents: {
      defaults: { workspace: path.join(process.cwd(), "tmp-default-workspace") },
      entries: { main: {}, recall: { workspace: recallWorkspace } },
    },
  } as never;
  const result = resolve({
    config,
    agentSessionKey: "explicit:user-session:active-memory:abc123",
    requesterAgentIdOverride: "recall",
  });

  expect(result).toMatchObject({ agentId: "recall", workspaceDir: recallWorkspace });
});

it("keeps the routable conversation target ahead of the native channel id", () => {
  const result = resolve({
    agentChannel: "slack",
    currentMessagingTarget: "user:U123",
    currentChannelId: "D123",
  });

  expect(result.deliveryContext?.to).toBe("user:U123");
});

it.each([
  { approvalReviewerDeviceIds: ["device-reviewer"] },
  { approvalReviewerDeviceId: "device-reviewer" },
])("carries host-selected approval reviewers into plugin tools: %j", (options) => {
  expect(resolve(options).approvalReviewerDeviceIds).toEqual(["device-reviewer"]);
});

it("forwards the run id and host-stamped input provenance to plugin tools", () => {
  const inputProvenance = {
    kind: "internal_system" as const,
    sourceTool: "exec",
    runId: "owner-run",
  };
  expect(resolve({ runId: "wake-run", inputProvenance })).toMatchObject({
    runId: "wake-run",
    inputProvenance,
  });
});
