import path from "node:path";
import {
  getSessionEntryAsync,
  normalizeSessionDeliveryState,
  type SessionEntry,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import {
  parseMattermostModelPickerContext,
  renderMattermostModelSummaryView,
  renderMattermostModelsPickerView,
  renderMattermostProviderPickerView,
  resolveMattermostModelPickerCurrentModel,
  resolveMattermostModelPickerEntry,
} from "./model-picker.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync(sessionRoot);
    cleanup();
  });
});
const sessionRoot = tempDirs.make("mm-model-picker-");

const data = {
  byProvider: new Map<string, Set<string>>([
    ["anthropic", new Set(["claude-opus-4-5", "claude-sonnet-4-5"])],
    ["openai", new Set(["gpt-4.1", "gpt-5"])],
  ]),
  providers: ["anthropic", "openai"],
  resolvedDefault: {
    provider: "anthropic",
    model: "claude-opus-4-5",
  },
  modelNames: new Map<string, string>(),
  modelCatalog: [],
};

describe("Mattermost model picker", () => {
  it("resolves bare /model and /models entry points", () => {
    expect(resolveMattermostModelPickerEntry("/model")).toEqual({ kind: "summary" });
    expect(resolveMattermostModelPickerEntry("/models")).toEqual({ kind: "providers" });
    expect(resolveMattermostModelPickerEntry("/models OpenAI")).toEqual({
      kind: "models",
      provider: "openai",
    });
    expect(resolveMattermostModelPickerEntry("/model openai/gpt-5")).toBeNull();
  });

  it("trims accidental model spacing in Mattermost current-model text", () => {
    const view = renderMattermostModelSummaryView({
      ownerUserId: "user-1",
      currentModel: " OpenAI/ gpt-5 ",
    });

    expect(view.text).toContain("Current: openai/gpt-5");
    expect(view.text).toContain("Tap below to browse models");
    expect(view.text).toContain("/oc_model <provider/model> to switch");
    expect(view.text).toContain("Browse keeps the current runtime");
    expect(view.text).toContain("/oc_model <provider/model> --runtime <runtime>");
    expect(view.buttons[0]?.[0]?.text).toBe("Browse providers");
  });

  it("renders providers and models with Telegram-style navigation", () => {
    const providersView = renderMattermostProviderPickerView({
      ownerUserId: "user-1",
      data,
      currentModel: "openai/gpt-5",
    });
    const providerTexts = providersView.buttons.flat().map((button) => button.text);
    expect(providerTexts).toContain("anthropic (2)");
    expect(providerTexts).toContain("openai (2)");

    const modelsView = renderMattermostModelsPickerView({
      ownerUserId: "user-1",
      data,
      provider: "openai",
      page: 1,
      currentModel: "openai/gpt-5",
    });
    const modelTexts = modelsView.buttons.flat().map((button) => button.text);
    expect(modelsView.text).toContain("Models (openai) - 2 available");
    expect(modelTexts).toContain("gpt-5 [current]");
    expect(modelTexts).toContain("Back to providers");
    const ids = modelsView.buttons.flat().map((button) => button.id);
    expect(ids.every((id) => typeof id === "string" && /^[a-z0-9]+$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("parses signed picker contexts", () => {
    const context = {
      action: "select",
      ownerUserId: "user-1",
      provider: "openai",
      page: 2,
      model: "gpt-5",
    };
    expect(parseMattermostModelPickerContext({ oc_model_picker: true, ...context })).toEqual(
      context,
    );
    expect(parseMattermostModelPickerContext({ action: "select" })).toBeNull();
  });

  it("does not coerce partial page strings in signed picker contexts", () => {
    const context = {
      action: "list",
      ownerUserId: "user-1",
      provider: "openai",
    };
    const parsePage = (page: string) =>
      parseMattermostModelPickerContext({ oc_model_picker: true, ...context, page });
    expect(parsePage("+02")).toEqual({ ...context, page: 2 });
    expect(parsePage("2next")).toEqual({ ...context, page: 1 });
  });

  it("falls back to the routed agent default model when no override is stored", async () => {
    const testDir = tempDirs.make("case-", sessionRoot);
    const cfg: OpenClawConfig = {
      session: { store: path.join(testDir, "{agentId}.json") },
      agents: {
        defaults: { model: "anthropic/claude-opus-4-5" },
        entries: { support: { model: "openai/gpt-5" } },
      },
    };
    expect(
      await resolveMattermostModelPickerCurrentModel({
        cfg,
        route: { agentId: "support", sessionKey: "agent:support:main" },
        data: { ...data, resolvedDefault: { provider: "openai", model: "gpt-5" } },
        sessionEntry: undefined,
      }),
    ).toBe("openai/gpt-5");
  });

  it("resolves current and parent model overrides from targeted session entries", async () => {
    const testDir = tempDirs.make("case-", sessionRoot);
    const storePath = path.join(testDir, "agents", "{agentId}", "sessions", "sessions.json");
    const supportStorePath = path.join(testDir, "agents", "support", "sessions", "sessions.json");
    const parentSessionKey = "agent:support:mattermost:default:channel-1";
    const childSessionKey = "agent:support:mattermost:default:child-with-explicit-parent";
    const directSessionKey = "agent:support:mattermost:default:direct-1";
    const save = (sessionKey: string, channel: string, entry: Partial<SessionEntry>) =>
      upsertSessionEntry({
        agentId: "support",
        storePath: supportStorePath,
        sessionKey,
        entry: {
          sessionId: sessionKey,
          updatedAt: 1,
          chatType: "channel",
          delivery: normalizeSessionDeliveryState({ context: { channel } }),
          ...entry,
        },
      });
    await save(parentSessionKey, "channel-1", {
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-5",
    });
    await save(childSessionKey, "child-with-explicit-parent", { parentSessionKey });
    await save(directSessionKey, "direct-1", {
      providerOverride: "openai",
      modelOverride: "gpt-5",
    });
    const currentModel = async (sessionKey: string, loadEntry = true) =>
      resolveMattermostModelPickerCurrentModel({
        cfg: { session: { store: storePath } },
        route: { agentId: "support", sessionKey },
        data,
        sessionEntry: loadEntry
          ? await getSessionEntryAsync({
              agentId: "support",
              storePath: supportStorePath,
              sessionKey,
            })
          : undefined,
      });
    expect(await currentModel(directSessionKey)).toBe("openai/gpt-5");
    expect(await currentModel(childSessionKey)).toBe("anthropic/claude-sonnet-4-5");
    expect(await currentModel(`${parentSessionKey}:thread:new-thread`, false)).toBe(
      "anthropic/claude-sonnet-4-5",
    );
  });
});
