import fs from "node:fs";
import os from "node:os";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as bindings from "openclaw/plugin-sdk/conversation-binding-runtime";
import { useBundledProviderPolicyArtifactsForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import * as sessions from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelType, type AutocompleteInteraction } from "../internal/discord.js";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

type BindingResolution = NonNullable<
  ReturnType<typeof bindings.resolveConfiguredBindingRoute>["bindingResolution"]
>;
vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof bindings>()),
  ensureConfiguredBindingRouteReady: vi.fn<typeof bindings.ensureConfiguredBindingRouteReady>(),
  resolveConfiguredBindingRoute: vi.fn<typeof bindings.resolveConfiguredBindingRoute>(),
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  getPreparedModelCatalogSnapshot: vi.fn(() => ({ entries: [], routeVariants: [] })),
  loadPreparedModelCatalog: vi.fn(async () => []),
  normalizeProviderId: (value: string) => value.trim().toLowerCase(),
  resolveAgentDir: (_cfg: OpenClawConfig, agentId: string) => `/tmp/agents/${agentId}/agent`,
  resolveAgentWorkspaceDir: (_cfg: OpenClawConfig, agentId: string) => `/tmp/workspaces/${agentId}`,
  resolveDefaultModelForAgent: () => ({ provider: "anthropic", model: "claude-sonnet-4.5" }),
}));

const STORE_PATH = `${os.tmpdir()}/openclaw-discord-think-autocomplete-${process.pid}.json`;
const SESSION_KEY = "agent:main:main";
afterEach(() => {
  sessions.clearSessionStoreCacheForTest();
  fs.rmSync(STORE_PATH, { force: true });
});

it("reads configured binding choices without preparing its runtime", async () => {
  const { resolveDiscordNativeChoiceContext } = await import("./native-command-model-picker-ui.js");
  sessions.clearSessionStoreCacheForTest();
  await sessions.upsertSessionEntry({
    storePath: STORE_PATH,
    sessionKey: SESSION_KEY,
    entry: {
      sessionId: "main",
      updatedAt: Date.now(),
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
    },
  });
  vi.mocked(bindings.resolveConfiguredBindingRoute).mockImplementation(({ route }) => ({
    bindingResolution: {
      record: {
        bindingId: "binding-1",
        targetSessionKey: SESSION_KEY,
        targetKind: "session",
        status: "active",
        boundAt: Date.now(),
        conversation: { channel: "discord", accountId: "default", conversationId: "C1" },
      },
    } as BindingResolution,
    boundSessionKey: SESSION_KEY,
    route: {
      ...route,
      agentId: "main",
      sessionKey: SESSION_KEY,
      matchedBy: "binding.channel",
      lastRoutePolicy: "session",
    },
  }));
  vi.mocked(bindings.ensureConfiguredBindingRouteReady).mockResolvedValue({
    ok: false,
    error: "acpx exited",
  });
  const cfg: OpenClawConfig = {
    agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4.5" } } },
    session: { store: STORE_PATH },
  };
  const channel = { id: "C1", type: ChannelType.GuildText };
  const interaction = {
    rawData: { member: { roles: [] } },
    channel,
    user: { id: "U1" },
    guild: { id: "G1" },
    client: { fetchChannel: async () => channel },
  } as unknown as AutocompleteInteraction;
  const context = await resolveDiscordNativeChoiceContext({
    interaction,
    cfg,
    accountId: "default",
    threadBindings: createNoopThreadBindingManager("default"),
  });

  expect(context).toMatchObject({ provider: "openai", model: "gpt-5.4", agentId: "main" });
  expect(bindings.ensureConfiguredBindingRouteReady).not.toHaveBeenCalled();
});

installDiscordIngressTestRuntime();
useBundledProviderPolicyArtifactsForTest(["openai", "anthropic"]);
