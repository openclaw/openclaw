import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { useBundledProviderPolicyArtifactsForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearSessionStoreCacheForTest,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ChannelType, type AutocompleteInteraction } from "../internal/discord.js";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

type ConversationRuntimeModule = typeof import("openclaw/plugin-sdk/conversation-binding-runtime");
type ResolveConfiguredBindingRoute = ConversationRuntimeModule["resolveConfiguredBindingRoute"];
type ConfiguredBindingRouteResult = ReturnType<ResolveConfiguredBindingRoute>;
type ConfiguredBindingResolution = NonNullable<ConfiguredBindingRouteResult["bindingResolution"]>;

const ensureConfiguredBindingRouteReadyMock = vi.hoisted(() =>
  vi.fn<ConversationRuntimeModule["ensureConfiguredBindingRouteReady"]>(),
);
const resolveConfiguredBindingRouteMock = vi.hoisted(() => vi.fn<ResolveConfiguredBindingRoute>());

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", async () => {
  const { createConfiguredBindingConversationRuntimeModuleMock } =
    await import("../test-support/configured-binding-runtime.js");
  return await createConfiguredBindingConversationRuntimeModuleMock<ConversationRuntimeModule>(
    { ensureConfiguredBindingRouteReadyMock, resolveConfiguredBindingRouteMock },
    () =>
      vi.importActual<ConversationRuntimeModule>(
        "openclaw/plugin-sdk/conversation-binding-runtime",
      ),
  );
});

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  getPreparedModelCatalogSnapshot: vi.fn(() => ({ entries: [], routeVariants: [] })),
  loadPreparedModelCatalog: vi.fn(async () => []),
  normalizeProviderId: (value: string) => value.trim().toLowerCase(),
  resolveAgentDir: (_cfg: OpenClawConfig, agentId: string) => `/tmp/agents/${agentId}/agent`,
  resolveAgentWorkspaceDir: (_cfg: OpenClawConfig, agentId: string) => `/tmp/workspaces/${agentId}`,
  resolveDefaultModelForAgent: () => ({ provider: "anthropic", model: "claude-sonnet-4.5" }),
}));

const STORE_PATH = path.join(
  os.tmpdir(),
  `openclaw-discord-think-autocomplete-${process.pid}.json`,
);
const SESSION_KEY = "agent:main:main";
let resolveDiscordNativeChoiceContext: typeof import("./native-command-model-picker-ui.js").resolveDiscordNativeChoiceContext;

describe("discord native /think autocomplete", () => {
  beforeAll(async () => {
    ({ resolveDiscordNativeChoiceContext } = await import("./native-command-model-picker-ui.js"));
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    try {
      fs.unlinkSync(STORE_PATH);
    } catch {}
  });

  it("reads configured binding choices without preparing its runtime", async () => {
    clearSessionStoreCacheForTest();
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    await upsertSessionEntry({
      storePath: STORE_PATH,
      sessionKey: SESSION_KEY,
      entry: {
        sessionId: "main",
        updatedAt: Date.now(),
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
      },
    });
    resolveConfiguredBindingRouteMock.mockImplementation(({ route }) => ({
      bindingResolution: {
        record: {
          bindingId: "binding-1",
          targetSessionKey: SESSION_KEY,
          targetKind: "session",
          status: "active",
          boundAt: Date.now(),
          conversation: { channel: "discord", accountId: "default", conversationId: "C1" },
        },
      } as ConfiguredBindingResolution,
      boundSessionKey: SESSION_KEY,
      route: {
        ...route,
        agentId: "main",
        sessionKey: SESSION_KEY,
        matchedBy: "binding.channel",
        lastRoutePolicy: "session",
      },
    }));
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({ ok: false, error: "acpx exited" });
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4.5" } } },
      session: { store: STORE_PATH },
    };
    const channel = { id: "C1", type: ChannelType.GuildText };
    const interaction = {
      options: { getFocused: () => ({ value: "xh" }) },
      respond: async (_choices: Array<{ name: string; value: string }>) => {},
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
    expect(ensureConfiguredBindingRouteReadyMock).not.toHaveBeenCalled();
  });
});

installDiscordIngressTestRuntime();
useBundledProviderPolicyArtifactsForTest(["openai", "anthropic"]);
