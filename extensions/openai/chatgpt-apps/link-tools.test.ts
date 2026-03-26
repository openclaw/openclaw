import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../../test/helpers/extensions/plugin-api.js";
import type { ChatgptAppsResolvedAuth } from "./auth-projector.js";
import type { AppInfo } from "./codex-sdk/generated/protocol/v2/AppInfo.js";
import { linkChatgptApp, listChatgptAppsForLinking } from "./link-service.js";
import { resetChatgptAppsLinkState } from "./link-state.js";
import { createChatgptAppsLinkToolFactory } from "./link-tools.js";

function createApp(params: {
  id: string;
  name: string;
  isAccessible: boolean;
  isEnabled: boolean;
  installUrl?: string | null;
  showInComposerWhenUnlinked?: boolean | null;
}): AppInfo {
  const installUrl =
    params.installUrl === undefined ? `https://chatgpt.com/apps/${params.id}` : params.installUrl;
  return {
    id: params.id,
    name: params.name,
    description: null,
    logoUrl: null,
    logoUrlDark: null,
    distributionChannel: null,
    branding: null,
    appMetadata:
      params.showInComposerWhenUnlinked === undefined
        ? null
        : {
            review: null,
            categories: null,
            subCategories: null,
            seoDescription: null,
            screenshots: null,
            developer: null,
            version: null,
            versionId: null,
            versionNotes: null,
            firstPartyType: null,
            firstPartyRequiresInstall: null,
            showInComposerWhenUnlinked: params.showInComposerWhenUnlinked,
          },
    labels: null,
    installUrl,
    isAccessible: params.isAccessible,
    isEnabled: params.isEnabled,
    pluginDisplayNames: [params.name],
  };
}

function createFakeLease(params: {
  inventory: AppInfo[];
  auth?: ChatgptAppsResolvedAuth | null;
  sidecarError?: string | null;
}) {
  let inventory = params.inventory;
  let source: "rpc" | "notification" = "rpc";
  const listeners = new Set<
    (snapshot: { apps: AppInfo[]; source: "rpc" | "notification"; updatedAt: string }) => void
  >();
  const auth =
    params.auth ??
    ({
      status: "ok",
      accessToken: "token-1",
      accountId: "acct-1",
      planType: "plus",
      identity: {
        email: "owner@example.com",
        profileName: "owner@example.com",
      },
    } satisfies ChatgptAppsResolvedAuth);

  return {
    session: {
      refreshInventory: vi.fn(async () => inventory),
      onInventoryUpdate(
        listener: (snapshot: {
          apps: AppInfo[];
          source: "rpc" | "notification";
          updatedAt: string;
        }) => void,
      ) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      snapshot: () => ({
        layout: {
          sessionKey: "/tmp/openai-chatgpt-apps-session",
          sandboxDir: "/tmp/openai-chatgpt-apps-session",
          configFilePath: "/tmp/openai-chatgpt-apps-session/config.toml",
        },
        clientReady: true,
        sidecarError: params.sidecarError ?? null,
        auth,
        projectedAccount: null,
        inventory: {
          apps: inventory,
          source,
          updatedAt: "2026-03-26T00:00:00.000Z",
        },
      }),
    },
    release: vi.fn(async () => undefined),
    emitInventory(nextInventory: AppInfo[], nextSource: "rpc" | "notification" = "notification") {
      inventory = nextInventory;
      source = nextSource;
      for (const listener of listeners) {
        listener({
          apps: inventory,
          source,
          updatedAt: "2026-03-26T00:00:00.000Z",
        });
      }
    },
  };
}

function createPluginApi() {
  return createTestPluginApi({
    id: "openai",
    name: "OpenAI Provider",
    source: "test",
    config: {} as OpenClawConfig,
    pluginConfig: {
      chatgptApps: {
        enabled: true,
        linking: {
          enabled: true,
        },
      },
    },
    runtime: {
      state: {
        resolveStateDir: () => "/tmp/openclaw-state",
      },
    } as never,
  });
}

describe("createChatgptAppsLinkToolFactory", () => {
  afterEach(() => {
    resetChatgptAppsLinkState();
  });

  it("exposes native link tools only for local owner contexts", () => {
    const factory = createChatgptAppsLinkToolFactory(createPluginApi());
    expect(factory).not.toBeNull();
    expect(factory?.({ senderIsOwner: false })).toBeNull();
    expect(factory?.({ senderIsOwner: true, messageChannel: "slack" })).toBeNull();

    const tools = factory?.({
      senderIsOwner: true,
      messageChannel: "webchat",
      workspaceDir: "/tmp/workspace",
    });
    expect(Array.isArray(tools)).toBe(true);
    const toolList = Array.isArray(tools) ? tools : tools ? [tools] : [];
    expect(toolList.map((tool: { name: string }) => tool.name)).toEqual([
      "chatgpt_apps",
      "chatgpt_app_link",
    ]);
  });
});

describe("ChatGPT app link service", () => {
  afterEach(() => {
    resetChatgptAppsLinkState();
  });

  it("groups inventory into accessible, linkable, disabled, and unavailable buckets", async () => {
    const lease = createFakeLease({
      inventory: [
        createApp({ id: "gmail", name: "Gmail", isAccessible: true, isEnabled: true }),
        createApp({
          id: "google_drive",
          name: "Google Drive",
          isAccessible: false,
          isEnabled: true,
        }),
        createApp({ id: "calendar", name: "Calendar", isAccessible: true, isEnabled: false }),
        createApp({
          id: "contacts",
          name: "Contacts",
          isAccessible: false,
          isEnabled: true,
          installUrl: null,
        }),
      ],
    });

    const result = await listChatgptAppsForLinking({
      config: {} as OpenClawConfig,
      pluginConfig: {
        chatgptApps: {
          enabled: true,
          linking: { enabled: true },
        },
      },
      stateDir: "/tmp/openclaw-state",
      acquireLease: vi.fn(async () => lease) as never,
    });

    expect(result).toMatchObject({ status: "ok", total: 4 });
    if (result.status !== "ok") {
      throw new Error("expected ok result");
    }
    expect(result.accessible.map((entry) => entry.id)).toEqual(["gmail"]);
    expect(result.linkable.map((entry) => entry.id)).toEqual(["google_drive"]);
    expect(result.linkedButLocallyDisabled.map((entry) => entry.id)).toEqual(["calendar"]);
    expect(result.unavailable.map((entry) => entry.id)).toEqual(["contacts"]);
  });

  it("fails closed when an app does not expose an install URL", async () => {
    const lease = createFakeLease({
      inventory: [
        createApp({
          id: "contacts",
          name: "Contacts",
          isAccessible: false,
          isEnabled: true,
          installUrl: null,
        }),
      ],
    });

    const result = await linkChatgptApp({
      config: {} as OpenClawConfig,
      pluginConfig: {
        chatgptApps: {
          enabled: true,
          linking: { enabled: true },
        },
      },
      stateDir: "/tmp/openclaw-state",
      appId: "contacts",
      waitForCompletion: false,
      openMode: "auto",
      acquireLease: vi.fn(async () => lease) as never,
      openUrl: vi.fn(async () => true),
    });

    expect(result).toMatchObject({
      status: "failed",
      reason: "missing_install_url",
      installUrl: null,
    });
  });

  it("waits for accessibility changes and warns when the linked app stays locally disabled", async () => {
    const lease = createFakeLease({
      inventory: [
        createApp({
          id: "google_drive",
          name: "Google Drive",
          isAccessible: false,
          isEnabled: true,
        }),
      ],
    });
    const openUrlMock = vi.fn(async () => true);

    const result = await linkChatgptApp({
      config: {} as OpenClawConfig,
      pluginConfig: {
        chatgptApps: {
          enabled: true,
          linking: { enabled: true, waitTimeoutMs: 10_000, pollIntervalMs: 10 },
        },
      },
      stateDir: "/tmp/openclaw-state",
      appId: "google_drive",
      waitForCompletion: true,
      openMode: "auto",
      acquireLease: vi.fn(async () => lease) as never,
      openUrl: openUrlMock,
      sleep: async () => {
        lease.emitInventory([
          createApp({
            id: "google_drive",
            name: "Google Drive",
            isAccessible: true,
            isEnabled: false,
          }),
        ]);
      },
    });

    expect(openUrlMock).toHaveBeenCalledWith("https://chatgpt.com/apps/google_drive");
    expect(result).toMatchObject({
      status: "linked",
      warning: {
        code: "linked_but_locally_disabled",
      },
    });
    expect(result.app?.linkState).toBe("linked_but_locally_disabled");
  });

  it("coalesces concurrent link attempts for the same app and account", async () => {
    const lease = createFakeLease({
      inventory: [
        createApp({
          id: "gmail",
          name: "Gmail",
          isAccessible: false,
          isEnabled: true,
        }),
      ],
    });
    const openUrlMock = vi.fn(async () => false);
    let emitted = false;

    const runLink = () =>
      linkChatgptApp({
        config: {} as OpenClawConfig,
        pluginConfig: {
          chatgptApps: {
            enabled: true,
            linking: { enabled: true, waitTimeoutMs: 10_000, pollIntervalMs: 10 },
          },
        },
        stateDir: "/tmp/openclaw-state",
        appId: "gmail",
        waitForCompletion: true,
        openMode: "auto",
        acquireLease: vi.fn(async () => lease) as never,
        openUrl: openUrlMock,
        sleep: async () => {
          if (!emitted) {
            emitted = true;
            lease.emitInventory([
              createApp({
                id: "gmail",
                name: "Gmail",
                isAccessible: true,
                isEnabled: true,
              }),
            ]);
          }
        },
      });

    const [first, second] = await Promise.all([runLink(), runLink()]);
    expect(openUrlMock).toHaveBeenCalledTimes(1);
    expect(first.status).toBe("linked");
    expect(second.status).toBe("linked");
  });
});
