import type { OpenClawConfig, SecretInput, WizardPrompter } from "openclaw/plugin-sdk";
import type {
  ChannelSetupWizardAdapter,
  ChannelSetupDmPolicy,
  DmPolicy,
  // promptSingleChannelSecretInput is dynamically imported at call sites (Issue #527)
} from "openclaw/plugin-sdk/setup";
import { resolveDingtalkAccount, resolveDingtalkCredentials } from "./config/accounts.ts";
import {
  beginDingtalkRegistration,
  renderQrCodeText,
  waitForDingtalkRegistrationSuccess,
} from "./device-auth.ts";
import { probeDingtalk } from "./probe.ts";
import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  hasConfiguredSecretInput,
} from "./sdk/helpers.ts";
import type { DingtalkConfig } from "./types/index.ts";

// eslint-disable-next-line openclaw/no-process-env -- setup wizard needs env vars for default credential hints
const _env = process.env;

const channel = "dingtalk" as const;
const DINGTALK_MANUAL_SETUP_DOC = "docs/DINGTALK_MANUAL_SETUP.md";

/**
 * 用新凭据建一次真实 WebSocket 握手，验证网关重启后一定能建立 Stream。
 * 不仅验 accessToken（卡不住 WebSocket 鉴权不通过），而是直接走 DWClient.connect 拿到 socket。
 *
 * 超时内成功：立刻 disconnect，返回 ok。
 * 超时/异常：返回 ok=false + 原因，向导拒绝写盘。
 */
async function validateDingtalkStreamConnection(params: {
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const timeoutMs = params.timeoutMs ?? 15_000;
  let client: unknown = null;
  const cleanup = async () => {
    try {
      const anyClient = client as {
        socket?: { readyState?: number };
        disconnect?: () => Promise<void>;
      };
      if (anyClient?.socket && anyClient.socket.readyState === 1 && anyClient.disconnect) {
        await anyClient.disconnect();
      }
    } catch {
      /* swallow disconnect errors during preflight teardown */
    }
  };

  try {
    const dingtalkStreamModule: any = await import("dingtalk-stream");
    const DWClient = dingtalkStreamModule.DWClient;
    if (!DWClient) {
      return { ok: false, error: "dingtalk-stream DWClient import failed" };
    }
    client = new DWClient({
      clientId: params.clientId,
      clientSecret: params.clientSecret,
      endpoint: "https://api.dingtalk.com",
      autoReconnect: false,
      keepAlive: false,
    });

    const connectPromise = (client as { connect: () => Promise<unknown> }).connect();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`stream connect timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    );
    await Promise.race([connectPromise, timeoutPromise]);
    await cleanup();
    return { ok: true };
  } catch (err: any) {
    await cleanup();
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * 在 cfg 写盘后真实调起 gateway restart，不再依赖用户手动执行。
 * 不管成败失败，都会 fallback 打印提示，避免在非 CLI 的 runtime 里盲 spawn。
 */
async function triggerGatewayRestart(
  runtime: { log?: (...args: unknown[]) => void } | undefined,
): Promise<void> {
  try {
    const { spawn } = await import("node:child_process");
    const child = spawn("openclaw", ["gateway", "restart"], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (err) => {
      runtime?.log?.(`[dingtalk] auto gateway restart failed: ${String(err)}`);
    });
    child.unref();
    runtime?.log?.("[dingtalk] triggered 'openclaw gateway restart' (detached)");
  } catch (err) {
    runtime?.log?.(
      `[dingtalk] auto gateway restart threw: ${String(err)}; please run 'openclaw gateway restart' manually`,
    );
  }
}

async function restartOpenclawGateway(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Configuration saved. The gateway will be restarted automatically.",
      "If messages still don't arrive, run it manually:",
      "",
      "  openclaw gateway restart",
      "",
      "If the restart fails, try:",
      "  openclaw gateway install --force",
    ].join("\n"),
    "OpenClaw gateway",
  );
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function setDingtalkDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy): OpenClawConfig {
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(cfg.channels?.["dingtalk"]?.allowFrom)?.map((entry) => String(entry))
      : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: {
        ...cfg.channels?.["dingtalk"],
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

function setDingtalkAllowFrom(cfg: OpenClawConfig, allowFrom: string[]): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: {
        ...cfg.channels?.["dingtalk"],
        allowFrom,
      },
    },
  };
}

function parseAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function promptDingtalkAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const existing = params.cfg.channels?.["dingtalk"]?.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist DingTalk DMs by user ID.",
      "You can find user ID in DingTalk admin console or via API.",
      "Examples:",
      "- user123456",
      "- user789012",
    ].join("\n"),
    "DingTalk allowlist",
  );

  while (true) {
    const entry = await params.prompter.text({
      message: "DingTalk allowFrom (user IDs)",
      placeholder: "user123456, user789012",
      initialValue: existing[0] ? String(existing[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = parseAllowFromInput(String(entry));
    if (parts.length === 0) {
      await params.prompter.note("Enter at least one user.", "DingTalk allowlist");
      continue;
    }

    const unique = [
      ...new Set([
        ...existing.map((v: string | number) => String(v).trim()).filter(Boolean),
        ...parts,
      ]),
    ];
    return setDingtalkAllowFrom(params.cfg, unique);
  }
}

async function noteDingtalkCredentialHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Go to DingTalk Open Platform (open-dev.dingtalk.com)",
      "2) Create an enterprise internal app",
      "3) Get Client ID and Client Secret from Credentials page",
      "4) Enable required permissions: im:message, im:chat",
      "5) Publish the app or add it to a test group",
      "Tip: you can also set DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET env vars.",
      `Docs: ${formatDocsLink("/channels/dingtalk", "dingtalk")}`,
    ].join("\n"),
    "DingTalk credentials",
  );
}

async function promptDingtalkClientId(params: {
  prompter: WizardPrompter;
  initialValue?: string;
}): Promise<string> {
  const clientId = String(
    await params.prompter.text({
      message: "Enter DingTalk Client ID",
      initialValue: params.initialValue,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
  return clientId;
}

async function tryScanAuthorizeDingtalk(prompter: WizardPrompter): Promise<{
  clientId: string;
  clientSecret: string;
} | null> {
  const useScanAuth = await prompter.confirm({
    message: "Use DingTalk one-click QR authorization to create app credentials?",
    initialValue: true,
  });
  if (!useScanAuth) {
    return null;
  }

  const begin = await beginDingtalkRegistration();
  const qr = await renderQrCodeText(begin.verificationUriComplete);

  if (!qr) {
    await prompter.note(
      [
        "QR rendering failed in current terminal.",
        `Authorization URL: ${begin.verificationUriComplete}`,
        "You can continue with URL authorization, or switch to manual credential input.",
      ].join("\n"),
      "DingTalk authorization",
    );
    const continueWithUrl = await prompter.confirm({
      message: "QR display failed. Continue with URL authorization?",
      initialValue: true,
    });
    if (!continueWithUrl) {
      await prompter.note(
        `已切换为手动配置流程。文档：${DINGTALK_MANUAL_SETUP_DOC}`,
        "DingTalk authorization",
      );
      // Explicitly fall back to manual flow
      return null;
    }
  }

  await prompter.note(
    [
      "Scan with DingTalk to configure your bot (请使用钉钉扫码，配置机器人):",
      `Authorization URL: ${begin.verificationUriComplete}`,
      "In the authorization page, you can create a new bot or bind an existing bot.",
      "Waiting for authorization result...",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  // QR must be written directly to stdout; clack note frames would break column alignment.
  if (qr) {
    process.stdout.write(qr.endsWith("\n") ? qr : `${qr}\n`);
  } else {
    process.stdout.write("[QR rendering unavailable, please open the link above]\n");
  }

  const result = await waitForDingtalkRegistrationSuccess({
    deviceCode: begin.deviceCode,
    intervalSeconds: begin.intervalSeconds,
    expiresInSeconds: begin.expiresInSeconds,
  });

  // 不要在此处提示 restart：cfg 还没被框架写盘，提前 restart 会让新进程读到旧凭据，
  // 导致"扫码后无法建立链接"。restart 提示统一移到 configure() 返回后由框架处理，
  // 或由 configure() 末尾在 cfg 组装完成后再发出。
  await prompter.note("Success! Bot configured. (机器人配置成功!)");

  return result;
}

function formatDingtalkAuthFailure(err: unknown): string {
  const raw = String(err ?? "");
  if (/timeout/i.test(raw)) {
    return "扫码授权超时。";
  }
  if (/expired/i.test(raw)) {
    return "扫码授权已过期。";
  }
  if (/authorization failed/i.test(raw) || /auth/i.test(raw)) {
    return "扫码授权失败。";
  }
  return "扫码授权未成功完成。";
}

async function noteDingtalkManualFallback(prompter: WizardPrompter, err: unknown): Promise<void> {
  await prompter.note(
    [
      `${formatDingtalkAuthFailure(err)} 你仍可继续安装并改用手动配置。`,
      `手动流程文档：${DINGTALK_MANUAL_SETUP_DOC}`,
    ].join("\n"),
    "DingTalk authorization",
  );
}

function setDingtalkGroupPolicy(
  cfg: OpenClawConfig,
  groupPolicy: "open" | "allowlist" | "disabled",
): OpenClawConfig {
  const prev = cfg.channels?.["dingtalk"] as DingtalkConfig | undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: {
        ...prev,
        // 保留上游决定（如 Stream preflight 失败时刷写的 enabled:false），
        // policy 修复器不得额外翻转连通开关。
        enabled: prev?.enabled ?? true,
        groupPolicy,
      },
    },
  };
}

/**
 * 向导成果的三项不变式修复器（纯函数，可独立回归测试）：
 *
 * 1）groupPolicy 恒为 "open"：消除“configured but silent”黑洞（allowlist 空名单拦群消息）。
 * 2）若 dmPolicy === "allowlist" 但 allowFrom 为空 → 自愈回 "open"（否则静默丢掉所有 DM）。
 * 3）多-agent 扁平默认：不管前置配置是什么版本，走完向导后全部一致。
 *
 * 导出给测试使用。
 */
export function enforceDingtalkPolicyInvariants(cfg: OpenClawConfig): OpenClawConfig {
  let next = setDingtalkGroupPolicy(cfg, "open");
  const existing = next.channels?.["dingtalk"] as DingtalkConfig | undefined;
  if (
    existing?.dmPolicy === "allowlist" &&
    (!existing.allowFrom || existing.allowFrom.length === 0)
  ) {
    next = setDingtalkDmPolicy(next, "open");
  }
  return next;
}

const dmPolicy: ChannelSetupDmPolicy = {
  label: "DingTalk",
  channel,
  policyKey: "channels.dingtalk.dmPolicy",
  allowFromKey: "channels.dingtalk.allowFrom",
  getCurrent: (cfg) =>
    (cfg.channels?.["dingtalk"] as DingtalkConfig | undefined)?.dmPolicy ?? "open",
  setPolicy: (cfg, policy) => setDingtalkDmPolicy(cfg, policy),
  promptAllowFrom: promptDingtalkAllowFrom,
};

export const dingtalkOnboardingAdapter: ChannelSetupWizardAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    // Use resolveDingtalkAccount to correctly support pure multi-account configs
    // where credentials are only under accounts.<id>, not at the top level.
    const defaultAccount = resolveDingtalkAccount({ cfg });
    const configured = defaultAccount.configured;

    let probeResult = null;
    if (configured && defaultAccount.clientId && defaultAccount.clientSecret) {
      try {
        probeResult = await probeDingtalk({
          clientId: defaultAccount.clientId,
          clientSecret: defaultAccount.clientSecret,
        });
      } catch {
        // Ignore probe errors
      }
    }

    const statusLines: string[] = [];
    if (!configured) {
      statusLines.push("DingTalk: needs app credentials");
    } else if (probeResult?.ok) {
      statusLines.push(`DingTalk: connected as ${probeResult.botName ?? "bot"}`);
    } else {
      statusLines.push("DingTalk: configured (connection not verified)");
    }

    return {
      channel,
      configured,
      statusLines,
      selectionHint: configured ? "configured" : "needs app creds",
      quickstartScore: configured ? 2 : 0,
    };
  },

  configure: async ({ cfg, prompter }) => {
    const dingtalkCfg = cfg.channels?.["dingtalk"] as DingtalkConfig | undefined;
    const resolved = resolveDingtalkCredentials(dingtalkCfg, {
      allowUnresolvedSecretRef: true,
    });
    const hasConfigSecret = hasConfiguredSecretInput(dingtalkCfg?.clientSecret);
    const hasConfigCreds = Boolean(
      typeof dingtalkCfg?.clientId === "string" && dingtalkCfg.clientId.trim() && hasConfigSecret,
    );
    let canUseEnv = Boolean(
      !hasConfigCreds && _env.DINGTALK_CLIENT_ID?.trim() && _env.DINGTALK_CLIENT_SECRET?.trim(),
    );

    let next = cfg;
    let clientId: string | null = null;
    let clientSecret: SecretInput | null = null;
    let clientSecretProbeValue: string | null = null;

    if (!resolved) {
      await noteDingtalkCredentialHelp(prompter);
    }

    // Check if we can use environment variables
    if (canUseEnv) {
      const useEnv = await prompter.confirm({
        message: "DINGTALK_CLIENT_ID + DINGTALK_CLIENT_SECRET detected. Use env vars?",
        initialValue: true,
      });

      if (useEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            dingtalk: { ...next.channels?.["dingtalk"], enabled: true },
          },
        };
        // Environment variables will be used, skip manual input
      } else {
        // User chose not to use env vars, proceed to manual input
        canUseEnv = false;
      }
    }

    // If not using env vars, authorize or prompt for credentials
    if (!canUseEnv) {
      // Check if we should keep existing configuration
      if (resolved && hasConfigSecret) {
        const keepExisting = await prompter.confirm({
          message: "DingTalk credentials already configured. Keep them?",
          initialValue: true,
        });

        if (!keepExisting) {
          // Preferred path: one-click QR authorization
          try {
            const authResult = await tryScanAuthorizeDingtalk(prompter);
            if (authResult) {
              clientId = authResult.clientId;
              clientSecret = authResult.clientSecret;
              clientSecretProbeValue = authResult.clientSecret;
            }
          } catch (err) {
            await noteDingtalkManualFallback(prompter, err);
          }

          // Fallback: manual input
          if (!clientId || !clientSecret) {
            clientId = await promptDingtalkClientId({
              prompter,
              initialValue:
                normalizeString(dingtalkCfg?.clientId) ?? normalizeString(_env.DINGTALK_CLIENT_ID),
            });

            const { promptSingleChannelSecretInput: promptSecretFallback } =
              await import("openclaw/plugin-sdk/setup");
            const clientSecretResult = await promptSecretFallback({
              cfg: next,
              prompter,
              providerHint: "dingtalk",
              credentialLabel: "Client Secret",
              accountConfigured: false,
              canUseEnv: false,
              hasConfigToken: false,
              envPrompt: "",
              keepPrompt: "",
              inputPrompt: "Enter DingTalk Client Secret",
              preferredEnvVar: "DINGTALK_CLIENT_SECRET",
            });

            if (clientSecretResult.action === "set") {
              clientSecret = clientSecretResult.value;
              clientSecretProbeValue = clientSecretResult.resolvedValue;
            }
          }
        }
        // If keepExisting is true, we don't modify anything
      } else {
        // No existing config: prefer one-click QR authorization
        try {
          const authResult = await tryScanAuthorizeDingtalk(prompter);
          if (authResult) {
            clientId = authResult.clientId;
            clientSecret = authResult.clientSecret;
            clientSecretProbeValue = authResult.clientSecret;
          }
        } catch (err) {
          await noteDingtalkManualFallback(prompter, err);
        }

        // Fallback to manual input if QR flow is skipped/failed
        if (!clientId || !clientSecret) {
          clientId = await promptDingtalkClientId({
            prompter,
            initialValue:
              normalizeString(dingtalkCfg?.clientId) ?? normalizeString(_env.DINGTALK_CLIENT_ID),
          });

          const { promptSingleChannelSecretInput: promptSecret } =
            await import("openclaw/plugin-sdk/setup");
          const clientSecretResult = await promptSecret({
            cfg: next,
            prompter,
            providerHint: "dingtalk",
            credentialLabel: "Client Secret",
            accountConfigured: false,
            canUseEnv: false,
            hasConfigToken: false,
            envPrompt: "",
            keepPrompt: "",
            inputPrompt: "Enter DingTalk Client Secret",
            preferredEnvVar: "DINGTALK_CLIENT_SECRET",
          });

          if (clientSecretResult.action === "set") {
            clientSecret = clientSecretResult.value;
            clientSecretProbeValue = clientSecretResult.resolvedValue;
          }
        }
      }
    }

    if (clientId && clientSecret) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          dingtalk: {
            ...next.channels?.["dingtalk"],
            enabled: true,
            clientId,
            clientSecret,
          },
        },
      };

      // 第一道闸：accessToken probe（走 OAuth）——能拿到 botName 证明 clientId/Secret 对得上
      let probeOk = false;
      try {
        const probe = await probeDingtalk({
          clientId,
          clientSecret: clientSecretProbeValue ?? undefined,
        });
        if (probe.ok) {
          probeOk = true;
          await prompter.note(`Connected as ${probe.botName ?? "bot"}`, "DingTalk connection test");
        } else {
          await prompter.note(
            `Connection failed: ${probe.error ?? "unknown error"}`,
            "DingTalk connection test",
          );
        }
      } catch (err) {
        await prompter.note(`Connection test failed: ${String(err)}`, "DingTalk connection test");
      }

      // 第二道闸：Stream 真实 WebSocket 握手——提前踩一遍，保证 gateway restart 后一定连得上。
      // 即使 probe 成功、Stream 也可能失败（企业内网代理、Stream 能力包未开启等），
      // 这里失败就不要写 enabled:true，避免 gateway 启动后用户陷入“配好了但发消息不回”的黑洞。
      if (probeOk) {
        const streamPre = await validateDingtalkStreamConnection({
          clientId,
          clientSecret: clientSecretProbeValue ?? clientSecret,
        });
        if (streamPre.ok) {
          await prompter.note(
            "Stream handshake ok (gateway restart will definitely connect)",
            "DingTalk stream preflight",
          );
        } else {
          await prompter.note(
            [
              `Stream handshake failed: ${streamPre.error}`,
              "",
              "Possible causes:",
              "  · Stream capability not enabled for this app",
              "  · Corporate proxy blocking wss",
              "  · clientSecret mismatch",
              "",
              "Keeping credentials but disabling channel until stream is reachable;",
              "after you fix the root cause re-run: openclaw configure --section channels",
            ].join("\n"),
            "DingTalk stream preflight",
          );
          next = {
            ...next,
            channels: {
              ...next.channels,
              dingtalk: {
                ...next.channels?.["dingtalk"],
                enabled: false,
              },
            },
          };
        }
      }
    }

    // 现在 cfg 已就绪，符合三项不变式（enabled 取决于 Stream preflight）：
    // 1）clientId/clientSecret 存在
    // 2）groupPolicy === "open"
    // 3）dmPolicy 不是 "allowlist + 空 allowFrom"
    // restart 不再在此提示手动，由 afterConfigWritten 直接 spawn，真正做到“扫完就连上”。
    next = enforceDingtalkPolicyInvariants(next);
    await restartOpenclawGateway(prompter);

    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },

  afterConfigWritten: async ({ runtime }) => {
    // cfg 已落盘 → 立刻拉起 gateway restart，避免用户在旧进程上继续命中旧凭据。
    await triggerGatewayRestart(runtime);
  },

  dmPolicy,

  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: { ...cfg.channels?.["dingtalk"], enabled: false },
    },
  }),
};
