import { describe, expect, it, vi } from "vitest";
import type { v2 } from "./app-server/protocol.js";
import type { CodexPluginConfigEntry } from "./command-plugin-config.js";
import { handleCodexPluginsSubcommand } from "./command-plugins-management.js";
import {
  buttonCommands,
  fakeCtx,
  inMemoryIO,
  pluginRuntime,
  pluginCatalog,
  pluginSummary,
  presentationButtons,
  type CodexPluginsManagementRuntime,
} from "./command-plugins-management.test-support.js";

const localPluginId = "security-review@company-tools";
const localMarketplace = { marketplacePath: "/repo/marketplace.json" };

function revocableOwner() {
  let current = true;
  return {
    revoke: () => {
      current = false;
    },
    ctx: {
      ...fakeCtx,
      assertOwnerCurrent: () => {
        if (!current) {
          throw new Error("Command owner was revoked");
        }
      },
    },
  };
}

function command(
  args: string[],
  io = inMemoryIO(),
  runtime: CodexPluginsManagementRuntime = pluginRuntime(),
  ctx = fakeCtx,
) {
  return handleCodexPluginsSubcommand(ctx, args, io, runtime);
}

function makePolicy(
  pluginName: string,
  marketplaceName = "company-tools",
  enabled = false,
  restrictions?: CodexPluginConfigEntry["allow_destructive_actions"],
) {
  return {
    enabled,
    marketplaceName,
    pluginName,
    ...(restrictions === undefined ? {} : { allow_destructive_actions: restrictions }),
  };
}
const configuredPlugin = (enabled = true) =>
  makePolicy("google-calendar", "openai-curated", enabled);

function app(id: string, name: string, installUrl: string): v2.AppSummary {
  return { id, name, description: null, installUrl, category: null };
}
function installingApps(appsNeedingAuth: v2.AppSummary[], setupAllowed = true) {
  return pluginRuntime({
    ...localMarketplace,
    setupAllowed,
    install: async () => ({ authPolicy: "ON_INSTALL", appsNeedingAuth }),
  });
}

describe("Codex /codex plugins subcommand", () => {
  it("lists effective disabled status when the global plugin switch is off", async () => {
    const io = inMemoryIO({ "google-calendar": configuredPlugin(true) }, { enabled: false });

    const result = await command(["list"], io);
    expect(result.text).toContain("OFF  google-calendar");
    expect(result.text).toContain("Global codexPlugins.enabled is off");
  });

  it("renders the plugins menu as portable slash-command buttons", async () => {
    const result = await command(["menu"]);

    expect(result.text).toContain("/codex plugins list");
    expect(buttonCommands(result)).toEqual([
      ...["list", "available", "refresh", "enable", "disable", "help"].map(
        (verb) => `/codex plugins ${verb}`,
      ),
      "/codex",
    ]);
  });

  it.each([
    ["enable", "google-calendar"],
    ["disable", "notion"],
  ])("renders the %s target picker from effective plugin state", async (verb, name) => {
    const io = inMemoryIO({
      "google-calendar": configuredPlugin(false),
      notion: makePolicy("notion", "openai-curated", true),
    });
    const result = await command([verb], io);
    const expected = `/codex plugins ${verb} ${name}`;
    expect(result.text).toContain(expected);
    expect(buttonCommands(result)).toEqual([expected, "/codex plugins menu"]);
  });

  it("enables and disables a configured plugin and reflects the change in subsequent reads", async () => {
    const io = inMemoryIO({ "google-calendar": configuredPlugin(true) });

    const disabled = await command(["disable", "google-calendar"], io);
    expect(disabled.text).toContain("disabled");
    expect(io.current()["google-calendar"]?.enabled).toBe(false);

    const enabled = await command(["enable", "google-calendar"], io);
    expect(enabled.text).toContain("enabled");
    expect(io.currentConfig().enabled).toBe(true);
    expect(io.current()["google-calendar"]?.enabled).toBe(true);
  });

  it("rejects enable and disable from non-owner non-admin callers", async () => {
    const io = inMemoryIO({ "google-calendar": configuredPlugin(true) });
    const ctx = { ...fakeCtx, senderIsOwner: false, gatewayClientScopes: ["operator.write"] };

    const result = await command(["disable", "google-calendar"], io, undefined, ctx);
    expect(result.text).toContain("Only an owner or operator.admin");
    expect(io.current()["google-calendar"]?.enabled).toBe(true);
  });

  it("blocks a plugin policy commit after owner revocation while waiting for config IO", async () => {
    const io = inMemoryIO({ calendar: { enabled: true } });
    const { ctx, revoke } = revocableOwner();
    await expect(
      command(
        ["disable", "calendar"],
        {
          ...io,
          mutate: async (update, assertCurrent) => {
            revoke();
            ctx.assertOwnerCurrent = () => {};
            await io.mutate(update, assertCurrent);
          },
        },
        undefined,
        ctx,
      ),
    ).rejects.toThrow("Command owner was revoked");
    expect(io.current().calendar?.enabled).toBe(true);
  });

  it("keeps a completed native install but blocks new policy authorization after revocation", async () => {
    const io = inMemoryIO();
    const { ctx, revoke } = revocableOwner();
    const runtime = pluginRuntime({
      marketplacePath: "/repo/company/.agents/plugins/marketplace.json",
      install: async () => {
        revoke();
        return { authPolicy: "ON_USE", appsNeedingAuth: [] };
      },
    });
    const result = await command(["install", localPluginId], io, runtime, ctx);
    expect(result.text).toContain("was installed in Codex but could not be authorized in OpenClaw");
    expect(result.text).toContain("Command owner was revoked");
    expect(io.current()).toEqual({});
  });

  it("installs remote plugins with their opaque remote identity and preserves exact summary ids", async () => {
    const io = inMemoryIO();
    const runtime = pluginRuntime({
      marketplace: "workspace-directory",
      remotePluginId: "plugins~Plugin_11111111111111111111111111111111",
    });

    const result = await command(["install", "security-review@workspace-directory"], io, runtime);

    expect(runtime.install).toHaveBeenCalledWith({
      remoteMarketplaceName: "workspace-directory",
      pluginName: "plugins~Plugin_11111111111111111111111111111111",
    });
    expect(io.current()["security-review@workspace-directory"]?.pluginName).toBe(
      "security-review@workspace-directory",
    );
    expect(result.text).toContain("bundle was installed in Codex");
  });

  it.each([
    { policy: true, message: "requires a Codex installation confirmation" },
    { policy: null, message: "did not provide its required installation-confirmation policy" },
  ] as const)(
    "honors remote Codex installation interstitial policy $policy without invoking plugin/install",
    async ({ policy, message }) => {
      const runtime = pluginRuntime({
        marketplace: "workspace-directory",
        remotePluginId: "plugins~Plugin_remote_opaque",
        mustShowInstallationInterstitial: policy,
      });

      const result = await command(
        ["install", "security-review@workspace-directory"],
        inMemoryIO(),
        runtime,
      );

      expect(runtime.install).not.toHaveBeenCalled();
      expect(result.text).toContain(message);
      expect(result.text).toContain("Install it in Codex first");
    },
  );

  it("preserves existing curated authorization when discovery reports the openai-api-curated wire alias", async () => {
    const marketplace = "openai-api-curated";
    const io = inMemoryIO({ github: makePolicy("github", "openai-curated", false, "ask") });
    const runtime = pluginRuntime({
      marketplace,
      pluginName: "github",
      remotePluginId: "plugins~Plugin_github_opaque",
    });

    const result = await command(["install", `github@${marketplace}`], io, runtime);

    expect(io.current()).toEqual({
      github: makePolicy("github", "openai-curated", true, "ask"),
    });
    expect(runtime.install).toHaveBeenCalledWith({
      remoteMarketplaceName: marketplace,
      pluginName: "plugins~Plugin_github_opaque",
    });
    expect(result.text).toContain("bundle was installed in Codex");
  });

  it.each(["active", "restricted"] as const)(
    "preserves %s policy across curated wire aliases",
    async (mode) => {
      const io = inMemoryIO();
      const remotePluginId = "plugins~Plugin_github_opaque";
      const runtime = {
        ...pluginRuntime({ pluginName: "github", remotePluginId }),
        list: vi.fn(async (params: v2.PluginListParams) => {
          const supplemental = Boolean(params.marketplaceKinds);
          const marketplace = supplemental ? "openai-curated-remote" : "openai-curated";
          const summary: v2.PluginSummary = pluginSummary("github", marketplace, {
            remotePluginId,
          });
          if (mode === "active") {
            Object.assign(summary, {
              installed: supplemental,
              enabled: supplemental,
              mustShowInstallationInterstitial: true,
            });
          } else if (supplemental) {
            summary.availability = "DISABLED_BY_ADMIN";
          }
          return pluginCatalog([summary], marketplace);
        }),
      } satisfies CodexPluginsManagementRuntime;
      const result = await command(["install", "github@openai-curated"], io, runtime);
      expect(runtime.install).not.toHaveBeenCalled();
      if (mode === "active") {
        expect(io.current()).toHaveProperty("github@openai-curated");
        expect(result.text).toContain("bundle was already installed in Codex");
      } else {
        expect(result.text).toContain("unavailable or disabled");
      }
    },
  );

  it("rejects a curated alias when the canonical config slot belongs to another plugin", async () => {
    const io = inMemoryIO({
      "github@openai-curated": makePolicy("security-review", "company-tools", false, true),
    });
    const runtime = pluginRuntime({
      marketplace: "openai-curated-remote",
      pluginName: "github",
      remotePluginId: "plugins~Plugin_github_opaque",
    });

    const result = await command(["install", "github@openai-curated-remote"], io, runtime);

    expect(result.text).toContain("points to a different plugin identity");
    expect(runtime.install).not.toHaveBeenCalled();
    expect(io.current()["github@openai-curated"]?.enabled).toBe(false);
  });

  it("rejects a mismatched install identity without breaking exact legacy lifecycle keys", async () => {
    const io = inMemoryIO({
      "security-review@company-tools": makePolicy(
        "different-plugin",
        "another-marketplace",
        false,
        true,
      ),
    });
    const runtime = pluginRuntime(localMarketplace);

    const installed = await command(["install", localPluginId], io, runtime);
    const enabled = await command(["enable", localPluginId], io);
    expect(installed.text).toContain("points to a different plugin identity");
    expect(enabled.text).toContain("enabled in openclaw.json");
    expect(enabled.text).toContain("Takes effect on your next message.");
    expect(runtime.install).not.toHaveBeenCalled();
    expect(io.current()[localPluginId]).toEqual(
      makePolicy("different-plugin", "another-marketplace", true, true),
    );
  });

  it("rejects duplicate legacy policies before installation or qualified enablement", async () => {
    const io = inMemoryIO({
      first: makePolicy("security-review", "company-tools", false, false),
      second: makePolicy("security-review@company-tools", "company-tools", false, true),
    });
    const runtime = pluginRuntime(localMarketplace);

    const installed = await command(["install", localPluginId], io, runtime);
    const enabled = await command(["enable", localPluginId], io);
    const enabledDirect = await command(["enable", "first"], io);

    expect(installed.text).toContain("Multiple configured Codex plugins match");
    expect(enabled.text).toContain("Multiple configured Codex plugins match");
    expect(enabledDirect.text).toContain("Multiple configured Codex plugins match");
    expect(runtime.install).not.toHaveBeenCalled();
    expect(Object.keys(io.current())).toEqual(["first", "second"]);
    expect(io.current().first?.enabled).toBe(false);
    expect(io.current().second?.enabled).toBe(false);
  });

  it("rejects direct legacy enablement when another plugin occupies its canonical slot", async () => {
    const io = inMemoryIO({
      security: makePolicy("security-review", "company-tools", false),
      "security-review@company-tools": makePolicy("another-plugin", "different-tools", false),
    });

    const result = await command(["enable", "security"], io);

    expect(result.text).toContain("points to a different plugin identity");
    expect(io.current().security?.enabled).toBe(false);
    expect(io.current()["security-review@company-tools"]?.enabled).toBe(false);
  });

  it("allows operator.admin installation but rejects ordinary users before catalog access", async () => {
    const io = inMemoryIO();
    const runtime = pluginRuntime(localMarketplace);
    const denied = { ...fakeCtx, senderIsOwner: false, gatewayClientScopes: ["operator.write"] };

    const rejected = await command(["install", localPluginId], io, runtime, denied);
    expect(rejected.text).toContain("Only an owner or operator.admin");
    expect(runtime.workspaceDir).not.toHaveBeenCalled();
    expect(runtime.list).not.toHaveBeenCalled();
    expect(runtime.install).not.toHaveBeenCalled();

    const allowed = await command(["install", localPluginId], io, runtime, {
      ...fakeCtx,
      senderIsOwner: false,
      gatewayClientScopes: ["operator.admin"],
      assertOwnerCurrent: () => {
        throw new Error("Caller is not a channel owner");
      },
    });
    expect(allowed.text).toContain("bundle was installed in Codex");
  });

  it("does not mutate explicit plugin authorization when Codex installation fails", async () => {
    const io = inMemoryIO({}, { enabled: false });
    const runtime = pluginRuntime({
      ...localMarketplace,
      install: vi.fn(async () => {
        throw new Error("workspace administrator rejected installation");
      }),
    });

    const result = await command(["install", localPluginId], io, runtime);

    expect(result.text).toContain("workspace administrator rejected installation");
    expect(io.currentConfig()).toEqual({ enabled: false, plugins: {} });
  });

  it("keeps the completed installation but withholds a setup URL when current app access cannot be confirmed", async () => {
    const io = inMemoryIO();
    const runtime = installingApps(
      [app("github", "GitHub", "https://chatgpt.com/apps/github/connector_github")],
      false,
    );
    const result = await command(["install", localPluginId], io, runtime);
    expect(result.text).toContain("setup permissions could not be confirmed");
    expect(result.text).toContain("/codex plugins status security-review@company-tools");
    expect(result.text).not.toContain("https://chatgpt.com/apps/");
    expect(io.current()["security-review@company-tools"]?.enabled).toBe(true);
  });

  it.each([
    "http://chatgpt.com/apps/github/github",
    "https://fixture-user@chatgpt.com/apps/github/github",
    "https://evilchatgpt.com/apps/github/github",
    "https://chatgpt.com/\u0000apps/github/github",
  ])("gives a manual setup path without exposing unsafe or missing URL %j", async (installUrl) => {
    const io = inMemoryIO();
    const runtime = installingApps([app("github", "GitHub", installUrl)]);

    const result = await command(["install", localPluginId], io, runtime);

    expect(result.text).toContain("GitHub: ChatGPT setup/manage link unavailable");
    expect(result.text).toContain("In Codex CLI, run /apps and select this app");
    expect(presentationButtons(result).some((button) => button.action?.type === "url")).toBe(false);
    expect(result.text).not.toContain(installUrl);
    expect(io.current()["security-review@company-tools"]?.enabled).toBe(true);
  });

  it("bounds app setup output and accounts for apps beyond the displayed links", async () => {
    const runtime = installingApps(
      Array.from({ length: 7 }, (_, index) =>
        app(`app-${index}`, `App ${index}`, `https://chatgpt.com/apps/app-${index}/app-${index}`),
      ),
    );

    const result = await command(["install", localPluginId], inMemoryIO(), runtime);

    const buttons = presentationButtons(result).filter((button) => button.action?.type === "url");
    expect(buttons?.map((button) => button.label)).toEqual(
      Array.from({ length: 5 }, (_, index) => `Open App ${index} in ChatGPT`),
    );
    expect(result.text).toContain("7 apps still require connector authentication");
    expect(result.text).toContain("2 more apps are not shown");
    expect(result.text).toContain("In Codex CLI, run /apps to review the remaining apps");
  });

  it("rejects unsafe or ambiguous marketplace identifiers before contacting Codex", async () => {
    const runtime = pluginRuntime(localMarketplace);

    const result = await command(["install", "../plugin@company-tools"], inMemoryIO(), runtime);

    expect(result.text).toContain("Invalid plugin identifier");
    expect(runtime.list).not.toHaveBeenCalled();
  });

  it("escapes configured plugin fields before listing them in chat", async () => {
    const io = inMemoryIO({
      "google-calendar": makePolicy("google-calendar_@team_*name*", "openai-curated", true),
    });

    const result = await command(["list"], io);
    expect(result.text).toContain("ON   google-calendar");
    expect(result.text).toContain("openclaw.json");
    expect(result.text).toContain("/codex plugins status <name>@<marketplace>");
    expect(result.text).toContain("google-calendar＿＠team＿∗name∗");
    expect(result.text).not.toContain("@team");
    expect(result.text).not.toContain("*name*");
  });

  it("reports when a target plugin is not configured rather than silently no-oping", async () => {
    const result = await command(["disable", "chrome_@ops"]);
    expect(result.text).toContain("not configured");
    expect(result.text).toContain("chrome＿＠ops");
    expect(result.text).not.toContain("@ops");
  });

  it.each([
    { args: ["list", "chrome"], usage: "list" },
    { args: ["menu", "extra"], usage: "menu" },
    { args: ["enable", "google-calendar", "extra"], usage: "enable <name>" },
  ])("returns usage for invalid $args", async ({ args, usage }) => {
    expect((await command(args)).text).toContain(`Usage: /codex plugins ${usage}`);
  });
});
