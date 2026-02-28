import type { DmPolicy, OpenClawConfig } from "openclaw/plugin-sdk";
import {
  addWildcardAllowFrom,
  formatDocsLink,
  promptChannelAccessConfig,
  type ChannelOnboardingAdapter,
  type ChannelOnboardingDmPolicy,
  type WizardPrompter,
} from "openclaw/plugin-sdk";
import { resolveMatrixAccount } from "./dejoy/accounts.js";
import { ensureMatrixSdkInstalled, isMatrixSdkAvailable } from "./dejoy/deps.js";
import { listDeJoyDirectoryGroupsLive } from "./directory-live.js";
import { resolveMatrixTargets } from "./resolve-targets.js";
import type { CoreConfig } from "./types.js";

const channel = "dejoy" as const;

function setDeJoyDmPolicy(cfg: OpenClawConfig, policy: DmPolicy): OpenClawConfig {
  const core = cfg as CoreConfig;
  const allowFrom =
    policy === "open" ? addWildcardAllowFrom(core.channels?.dejoy?.dm?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dejoy: {
        ...core.channels?.dejoy,
        dm: {
          ...core.channels?.dejoy?.dm,
          policy,
          ...(allowFrom ? { allowFrom } : {}),
        },
      },
    } as OpenClawConfig["channels"],
  };
}

async function noteDeJoyAuthHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "DeJoy requires a homeserver URL.",
      "Use an access token (recommended) or a password (logs in and stores a token).",
      "With access token: user ID is fetched automatically.",
      "Env vars supported: DEJOY_HOMESERVER, DEJOY_USER_ID, DEJOY_ACCESS_TOKEN, DEJOY_PASSWORD.",
      `Docs: ${formatDocsLink("/channels/dejoy", "channels/dejoy")}`,
    ].join("\n"),
    "DeJoy setup",
  );
}

async function promptDeJoyAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter } = params;
  const core = cfg as CoreConfig;
  const existingAllowFrom = core.channels?.dejoy?.dm?.allowFrom ?? [];
  const account = resolveMatrixAccount({ cfg: core });
  const canResolve = Boolean(account.configured);

  const parseInput = (raw: string) =>
    raw
      .split(/[\n,;]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);

  const isFullUserId = (value: string) => value.startsWith("@") && value.includes(":");

  while (true) {
    const entry = await prompter.text({
      message: "DeJoy allowFrom (full @user:server; display name only if unique)",
      placeholder: "@user:server",
      initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = parseInput(String(entry));
    const resolvedIds: string[] = [];
    const pending: string[] = [];
    const unresolved: string[] = [];
    const unresolvedNotes: string[] = [];

    for (const part of parts) {
      if (isFullUserId(part)) {
        resolvedIds.push(part);
        continue;
      }
      if (!canResolve) {
        unresolved.push(part);
        continue;
      }
      pending.push(part);
    }

    if (pending.length > 0) {
      const results = await resolveMatrixTargets({
        cfg,
        inputs: pending,
        kind: "user",
      }).catch(() => []);
      for (const result of results) {
        if (result?.resolved && result.id) {
          resolvedIds.push(result.id);
          continue;
        }
        if (result?.input) {
          unresolved.push(result.input);
          if (result.note) {
            unresolvedNotes.push(`${result.input}: ${result.note}`);
          }
        }
      }
    }

    if (unresolved.length > 0) {
      const details = unresolvedNotes.length > 0 ? unresolvedNotes : unresolved;
      await prompter.note(
        `Could not resolve:\n${details.join("\n")}\nUse full @user:server IDs.`,
        "DeJoy allowlist",
      );
      continue;
    }

    const unique = [
      ...new Set([
        ...existingAllowFrom.map((item) => String(item).trim()).filter(Boolean),
        ...resolvedIds,
      ]),
    ];
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        dejoy: {
          ...cfg.channels?.dejoy,
          enabled: true,
          dm: {
            ...cfg.channels?.dejoy?.dm,
            policy: "allowlist",
            allowFrom: unique,
          },
        },
      },
    };
  }
}

function setDeJoyGroupPolicy(cfg: CoreConfig, groupPolicy: "open" | "allowlist" | "disabled") {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dejoy: {
        ...cfg.channels?.dejoy,
        enabled: true,
        groupPolicy,
      },
    },
  };
}

function setDeJoyGroupRooms(cfg: CoreConfig, roomKeys: string[]) {
  const groups = Object.fromEntries(roomKeys.map((key) => [key, { allow: true }]));
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dejoy: {
        ...cfg.channels?.dejoy,
        enabled: true,
        groups,
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "DeJoy",
  channel,
  policyKey: "channels.dejoy.dm.policy",
  allowFromKey: "channels.dejoy.dm.allowFrom",
  getCurrent: (cfg) => (cfg as CoreConfig).channels?.dejoy?.dm?.policy ?? "pairing",
  setPolicy: (cfg, policy) => setDeJoyDmPolicy(cfg as CoreConfig, policy),
  promptAllowFrom: promptDeJoyAllowFrom,
};

export const dejoyOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const account = resolveMatrixAccount({ cfg: cfg as CoreConfig });
    const configured = account.configured;
    const sdkReady = isMatrixSdkAvailable();
    return {
      channel,
      configured,
      statusLines: [
        `DeJoy: ${configured ? "configured" : "needs homeserver + access token or password"}`,
      ],
      selectionHint: !sdkReady
        ? "install @vector-im/matrix-bot-sdk (DeJoy uses same protocol)"
        : configured
          ? "configured"
          : "needs auth",
    };
  },
  configure: async ({ cfg, runtime, prompter, forceAllowFrom }) => {
    let next = cfg as CoreConfig;
    await ensureMatrixSdkInstalled({
      runtime,
      confirm: async (message) =>
        await prompter.confirm({
          message,
          initialValue: true,
        }),
    });
    const existing = next.channels?.dejoy ?? {};
    const account = resolveMatrixAccount({ cfg: next });
    if (!account.configured) {
      await noteDeJoyAuthHelp(prompter);
    }

    const envHomeserver = process.env.DEJOY_HOMESERVER?.trim();
    const envUserId = process.env.DEJOY_USER_ID?.trim();
    const envAccessToken = process.env.DEJOY_ACCESS_TOKEN?.trim();
    const envPassword = process.env.DEJOY_PASSWORD?.trim();
    const envReady = Boolean(envHomeserver && (envAccessToken || (envUserId && envPassword)));

    if (
      envReady &&
      !existing.homeserver &&
      !existing.userId &&
      !existing.accessToken &&
      !existing.password
    ) {
      const useEnv = await prompter.confirm({
        message: "DeJoy env vars detected. Use env values?",
        initialValue: true,
      });
      if (useEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            dejoy: {
              ...next.channels?.dejoy,
              enabled: true,
            },
          },
        };
        if (forceAllowFrom) {
          next = await promptDeJoyAllowFrom({ cfg: next, prompter });
        }
        return { cfg: next };
      }
    }

    const homeserver = String(
      await prompter.text({
        message: "DeJoy homeserver URL",
        initialValue: existing.homeserver ?? envHomeserver,
        validate: (value) => {
          const raw = String(value ?? "").trim();
          if (!raw) {
            return "Required";
          }
          if (!/^https?:\/\//i.test(raw)) {
            return "Use a full URL (https://...)";
          }
          return undefined;
        },
      }),
    ).trim();

    let accessToken = existing.accessToken ?? "";
    let password = existing.password ?? "";
    let userId = existing.userId ?? "";

    if (accessToken || password) {
      const keep = await prompter.confirm({
        message: "DeJoy credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        accessToken = "";
        password = "";
        userId = "";
      }
    }

    if (!accessToken && !password) {
      // Ask auth method FIRST before asking for user ID
      const authMode = await prompter.select({
        message: "DeJoy auth method",
        options: [
          { value: "token", label: "Access token (user ID fetched automatically)" },
          { value: "password", label: "Password (requires user ID)" },
        ],
      });

      if (authMode === "token") {
        accessToken = String(
          await prompter.text({
            message: "DeJoy access token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        // With access token, we can fetch the userId automatically - don't prompt for it
        // The client.ts will use whoami() to get it
        userId = "";
      } else {
        // Password auth requires user ID upfront
        userId = String(
          await prompter.text({
            message: "DeJoy user ID",
            initialValue: existing.userId ?? envUserId,
            validate: (value) => {
              const raw = String(value ?? "").trim();
              if (!raw) {
                return "Required";
              }
              if (!raw.startsWith("@")) {
                return "DeJoy user IDs should start with @";
              }
              if (!raw.includes(":")) {
                return "DeJoy user IDs should include a server (:server)";
              }
              return undefined;
            },
          }),
        ).trim();
        password = String(
          await prompter.text({
            message: "DeJoy password",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    }

    const deviceName = String(
      await prompter.text({
        message: "DeJoy device name (optional)",
        initialValue: existing.deviceName ?? "OpenClaw Gateway",
      }),
    ).trim();

    // Ask about E2EE encryption
    const enableEncryption = await prompter.confirm({
      message: "Enable end-to-end encryption (E2EE)?",
      initialValue: existing.encryption ?? false,
    });

    next = {
      ...next,
      channels: {
        ...next.channels,
        dejoy: {
          ...next.channels?.dejoy,
          enabled: true,
          homeserver,
          userId: userId || undefined,
          accessToken: accessToken || undefined,
          password: password || undefined,
          deviceName: deviceName || undefined,
          encryption: enableEncryption || undefined,
        },
      },
    };

    if (forceAllowFrom) {
      next = await promptDeJoyAllowFrom({ cfg: next, prompter });
    }

    const existingGroups = next.channels?.dejoy?.groups ?? next.channels?.dejoy?.rooms;
    const accessConfig = await promptChannelAccessConfig({
      prompter,
      label: "DeJoy rooms",
      currentPolicy: next.channels?.dejoy?.groupPolicy ?? "allowlist",
      currentEntries: Object.keys(existingGroups ?? {}),
      placeholder: "!roomId:server, #alias:server, Project Room",
      updatePrompt: Boolean(existingGroups),
    });
    if (accessConfig) {
      if (accessConfig.policy !== "allowlist") {
        next = setDeJoyGroupPolicy(next, accessConfig.policy);
      } else {
        let roomKeys = accessConfig.entries;
        if (accessConfig.entries.length > 0) {
          try {
            const resolvedIds: string[] = [];
            const unresolved: string[] = [];
            for (const entry of accessConfig.entries) {
              const trimmed = entry.trim();
              if (!trimmed) {
                continue;
              }
              const cleaned = trimmed.replace(/^(room|channel):/i, "").trim();
              if (cleaned.startsWith("!") && cleaned.includes(":")) {
                resolvedIds.push(cleaned);
                continue;
              }
              const matches = await listDeJoyDirectoryGroupsLive({
                cfg: next,
                query: trimmed,
                limit: 10,
              });
              const exact = matches.find(
                (match) => (match.name ?? "").toLowerCase() === trimmed.toLowerCase(),
              );
              const best = exact ?? matches[0];
              if (best?.id) {
                resolvedIds.push(best.id);
              } else {
                unresolved.push(entry);
              }
            }
            roomKeys = [...resolvedIds, ...unresolved.map((entry) => entry.trim()).filter(Boolean)];
            if (resolvedIds.length > 0 || unresolved.length > 0) {
              await prompter.note(
                [
                  resolvedIds.length > 0 ? `Resolved: ${resolvedIds.join(", ")}` : undefined,
                  unresolved.length > 0
                    ? `Unresolved (kept as typed): ${unresolved.join(", ")}`
                    : undefined,
                ]
                  .filter(Boolean)
                  .join("\n"),
                "DeJoy rooms",
              );
            }
          } catch (err) {
            await prompter.note(
              `Room lookup failed; keeping entries as typed. ${String(err)}`,
              "DeJoy rooms",
            );
          }
        }
        next = setDeJoyGroupPolicy(next, "allowlist");
        next = setDeJoyGroupRooms(next, roomKeys);
      }
    }

    return { cfg: next };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...(cfg as CoreConfig),
    channels: {
      ...(cfg as CoreConfig).channels,
      dejoy: { ...(cfg as CoreConfig).channels?.dejoy, enabled: false },
    },
  }),
};
