import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy, DmPolicy } from "openclaw/plugin-sdk";
import { addWildcardAllowFrom, formatDocsLink, mergeAllowFromEntries } from "openclaw/plugin-sdk";
import type { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk";
import {
  DEFAULT_NAPCAT_HTTP_HOST,
  DEFAULT_NAPCAT_HTTP_PATH,
  DEFAULT_NAPCAT_HTTP_PORT,
  DEFAULT_NAPCAT_WS_RECONNECT_MS,
  DEFAULT_NAPCAT_WS_URL,
  resolveNapCatAccount,
} from "./accounts.js";
import { normalizeNapCatAllowEntry } from "./targets.js";
import type { NapCatConfig } from "./types.js";

const channel = "napcat" as const;

function parseAllowFromEntries(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => normalizeNapCatAllowEntry(entry))
    .filter(Boolean);
}

function setNapCatDmPolicy(cfg: OpenClawConfig, policy: DmPolicy): OpenClawConfig {
  const base = (cfg.channels?.napcat as NapCatConfig | undefined) ?? {};
  const allowFrom = policy === "open" ? addWildcardAllowFrom(base.dm?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      napcat: {
        ...base,
        dm: {
          ...base.dm,
          policy,
          ...(allowFrom ? { allowFrom } : {}),
        },
      },
    },
  };
}

async function promptNapCatAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const account = resolveNapCatAccount({ cfg: params.cfg });
  const existing = account.config.dm?.allowFrom ?? [];
  const entered = await params.prompter.text({
    message: "NapCat allowFrom (QQ user ids, comma-separated)",
    placeholder: "123456789, 987654321",
    initialValue: existing[0] ? String(existing[0]) : undefined,
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });
  const parsed = parseAllowFromEntries(String(entered));
  const merged = mergeAllowFromEntries(existing, parsed);
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      napcat: {
        ...account.config,
        enabled: true,
        dm: {
          ...account.config.dm,
          policy: "allowlist",
          allowFrom: merged,
        },
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "NapCat",
  channel,
  policyKey: "channels.napcat.dm.policy",
  allowFromKey: "channels.napcat.dm.allowFrom",
  getCurrent: (cfg) =>
    (((cfg.channels?.napcat as NapCatConfig | undefined)?.dm?.policy as DmPolicy | undefined) ??
      "pairing"),
  setPolicy: (cfg, policy) => setNapCatDmPolicy(cfg, policy),
  promptAllowFrom: async ({ cfg, prompter }) => promptNapCatAllowFrom({ cfg, prompter }),
};

async function noteSetup(prompter: WizardPrompter) {
  await prompter.note(
    [
      "NapCat uses OneBot11.",
      "OpenClaw can receive events from NapCat via HTTP webhook and/or WebSocket client mode.",
      "You need a shared token configured on both sides.",
      `Docs: ${formatDocsLink("/channels/napcat", "channels/napcat")}`,
    ].join("\n"),
    "NapCat setup",
  );
}

async function promptNapCatInboundTransportConfig(params: {
  current: ReturnType<typeof resolveNapCatAccount>;
  prompter: WizardPrompter;
}): Promise<{
  enableHttp: boolean;
  httpHost: string;
  httpPort: number;
  httpPath: string;
  enableWs: boolean;
  wsUrl: string;
  wsReconnectMs: number;
}> {
  while (true) {
    const enableHttp = await params.prompter.confirm({
      message: "Enable HTTP inbound webhook?",
      initialValue: params.current.transport.http.enabled,
    });

    let httpHost = params.current.transport.http.host;
    let httpPort = params.current.transport.http.port;
    let httpPath = params.current.transport.http.path;
    if (enableHttp) {
      httpHost = String(
        await params.prompter.text({
          message: "HTTP webhook host",
          initialValue: params.current.transport.http.host || DEFAULT_NAPCAT_HTTP_HOST,
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        }),
      ).trim();

      const portInput = String(
        await params.prompter.text({
          message: "HTTP webhook port",
          initialValue: String(params.current.transport.http.port || DEFAULT_NAPCAT_HTTP_PORT),
          validate: (value) => {
            const n = Number.parseInt(String(value ?? ""), 10);
            if (!Number.isInteger(n) || n < 1 || n > 65535) {
              return "Enter a valid port (1-65535)";
            }
            return undefined;
          },
        }),
      ).trim();
      httpPort = Number.parseInt(portInput, 10);

      httpPath = String(
        await params.prompter.text({
          message: "HTTP webhook path",
          initialValue: params.current.transport.http.path || DEFAULT_NAPCAT_HTTP_PATH,
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    const enableWs = await params.prompter.confirm({
      message: "Enable WebSocket inbound client?",
      initialValue: params.current.transport.ws.enabled,
    });

    let wsUrl = params.current.transport.ws.url;
    let wsReconnectMs = params.current.transport.ws.reconnectMs;
    if (enableWs) {
      wsUrl = String(
        await params.prompter.text({
          message: "NapCat WebSocket URL",
          initialValue: params.current.transport.ws.url || DEFAULT_NAPCAT_WS_URL,
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        }),
      ).trim();
      const reconnectInput = String(
        await params.prompter.text({
          message: "WebSocket reconnect interval (ms)",
          initialValue: String(
            params.current.transport.ws.reconnectMs || DEFAULT_NAPCAT_WS_RECONNECT_MS,
          ),
          validate: (value) => {
            const n = Number.parseInt(String(value ?? ""), 10);
            if (!Number.isInteger(n) || n <= 0) {
              return "Enter a positive integer";
            }
            return undefined;
          },
        }),
      ).trim();
      wsReconnectMs = Number.parseInt(reconnectInput, 10);
    }

    if (enableHttp || enableWs) {
      return {
        enableHttp,
        httpHost,
        httpPort,
        httpPath,
        enableWs,
        wsUrl,
        wsReconnectMs,
      };
    }

    // Keep the wizard on a valid path instead of writing a config that startup rejects.
    await params.prompter.note(
      "Enable at least one inbound transport (HTTP webhook or WebSocket client) before saving.",
      "NapCat transport",
    );
  }
}

export const napcatOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const account = resolveNapCatAccount({ cfg });
    return {
      channel,
      configured: account.configured,
      statusLines: [
        `NapCat: ${account.configured ? "configured" : "needs token + apiBaseUrl"}`,
      ],
      selectionHint: account.configured ? "configured" : "needs auth",
    };
  },
  configure: async ({ cfg, prompter, forceAllowFrom }) => {
    let next = cfg;
    await noteSetup(prompter);

    const current = resolveNapCatAccount({ cfg: next });

    const keepToken =
      current.tokenSource === "config" && current.token
        ? await prompter.confirm({
            message: "NapCat token already configured. Keep it?",
            initialValue: true,
          })
        : false;

    const token = keepToken
      ? current.token
      : String(
          await prompter.text({
            message: "NapCat shared token",
            initialValue:
              current.tokenSource === "config" && current.token ? current.token : undefined,
            validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
          }),
        ).trim();

    const apiBaseUrl = String(
      await prompter.text({
        message: "NapCat HTTP API base URL",
        initialValue: current.apiBaseUrl ?? "http://127.0.0.1:3000",
        validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
      }),
    ).trim();

    const {
      enableHttp,
      httpHost,
      httpPort,
      httpPath,
      enableWs,
      wsUrl,
      wsReconnectMs,
    } = await promptNapCatInboundTransportConfig({ current, prompter });

    next = {
      ...next,
      channels: {
        ...next.channels,
        napcat: {
          ...(next.channels?.napcat as NapCatConfig | undefined),
          enabled: true,
          token,
          apiBaseUrl,
          transport: {
            http: {
              enabled: enableHttp,
              host: enableHttp ? httpHost : current.transport.http.host,
              port: enableHttp ? httpPort : current.transport.http.port,
              path: enableHttp ? httpPath : current.transport.http.path,
            },
            ws: {
              enabled: enableWs,
              url: enableWs ? wsUrl : current.transport.ws.url,
              reconnectMs: enableWs ? wsReconnectMs : current.transport.ws.reconnectMs,
            },
          },
        } as NapCatConfig,
      },
    };

    if (forceAllowFrom) {
      next = await promptNapCatAllowFrom({ cfg: next, prompter });
    }

    return { cfg: next };
  },
  disable: (cfg) => {
    const section = (cfg.channels?.napcat as NapCatConfig | undefined) ?? {};
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        napcat: {
          ...section,
          enabled: false,
        },
      },
    };
  },
};
