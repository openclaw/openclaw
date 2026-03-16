import type { ChannelOnboardingDmPolicy } from "../../../src/channels/plugins/onboarding-types.js";
import { promptChannelAccessConfig } from "../../../src/channels/plugins/onboarding/channel-access.js";
import {
  addWildcardAllowFrom,
  buildSingleChannelSecretPromptState,
  mergeAllowFromEntries,
  promptSingleChannelSecretInput,
  setTopLevelChannelGroupPolicy,
} from "../../../src/channels/plugins/onboarding/helpers.js";
import type { ChannelSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { DmPolicy } from "../../../src/config/types.js";
import type { SecretInput } from "../../../src/config/types.secrets.js";
import { hasConfiguredSecretInput } from "../../../src/config/types.secrets.js";
import { formatResolvedUnresolvedNote } from "../../../src/plugin-sdk/resolution-notes.js";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import type { WizardPrompter } from "../../../src/wizard/prompts.js";
import { listMatrixDirectoryGroupsLive } from "./directory-live.js";
import { resolveMatrixAccount } from "./matrix/accounts.js";
import { ensureMatrixSdkInstalled, isMatrixSdkAvailable } from "./matrix/deps.js";
import { resolveMatrixTargets } from "./resolve-targets.js";
import { buildMatrixConfigUpdate, matrixSetupAdapter } from "./setup-core.js";
import type { CoreConfig } from "./types.js";

const channel = "matrix" as const;

function setMatrixDmPolicy(cfg: CoreConfig, policy: DmPolicy) {
  const allowFrom =
    policy === "open" ? addWildcardAllowFrom(cfg.channels?.matrix?.dm?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      matrix: {
        ...cfg.channels?.matrix,
        dm: {
          ...cfg.channels?.matrix?.dm,
          policy,
          ...(allowFrom ? { allowFrom } : {}),
        },
      },
    },
  };
}

async function noteMatrixAuthHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Matrix requires a homeserver URL.",
      "Use an access token (recommended) or a password (logs in and stores a token).",
      "With access token: user ID is fetched automatically.",
      "Env vars supported: MATRIX_HOMESERVER, MATRIX_USER_ID, MATRIX_ACCESS_TOKEN, MATRIX_PASSWORD.",
      `Docs: ${formatDocsLink("/channels/matrix", "channels/matrix")}`,
    ].join("\n"),
    "Matrix setup",
  );
}

async function promptMatrixAllowFrom(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
}): Promise<CoreConfig> {
  const { cfg, prompter } = params;
  const existingAllowFrom = cfg.channels?.matrix?.dm?.allowFrom ?? [];
  const account = resolveMatrixAccount({ cfg });
  const canResolve = Boolean(account.configured);

  const parseInput = (raw: string) =>
    raw
      .split(/[\n,;]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);

  const isFullUserId = (value: string) => value.startsWith("@") && value.includes(":");

  while (true) {
    const entry = await prompter.text({
      message: "Matrix allowFrom (full @user:server; display name only if unique)",
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
        "Matrix allowlist",
      );
      continue;
    }

    const unique = mergeAllowFromEntries(existingAllowFrom, resolvedIds);
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        matrix: {
          ...cfg.channels?.matrix,
          enabled: true,
          dm: {
            ...cfg.channels?.matrix?.dm,
            policy: "allowlist",
            allowFrom: unique,
          },
        },
      },
    };
  }
}

function setMatrixGroupPolicy(cfg: CoreConfig, groupPolicy: "open" | "allowlist" | "disabled") {
  return setTopLevelChannelGroupPolicy({
    cfg,
    channel: "matrix",
    groupPolicy,
    enabled: true,
  }) as CoreConfig;
}

function setMatrixGroupRooms(cfg: CoreConfig, roomKeys: string[]) {
  const groups = Object.fromEntries(roomKeys.map((key) => [key, { allow: true }]));
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      matrix: {
        ...cfg.channels?.matrix,
        enabled: true,
        groups,
      },
    },
  };
}

const matrixDmPolicy: ChannelOnboardingDmPolicy = {
  label: "Matrix",
  channel,
  policyKey: "channels.matrix.dm.policy",
  allowFromKey: "channels.matrix.dm.allowFrom",
  getCurrent: (cfg) => (cfg as CoreConfig).channels?.matrix?.dm?.policy ?? "pairing",
  setPolicy: (cfg, policy) => setMatrixDmPolicy(cfg as CoreConfig, policy),
  promptAllowFrom: promptMatrixAllowFrom,
};

export { matrixSetupAdapter } from "./setup-core.js";

export const matrixSetupWizard: ChannelSetupWizard = {
  channel,
  resolveAccountIdForConfigure: () => DEFAULT_ACCOUNT_ID,
  resolveShouldPromptAccountIds: () => false,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs homeserver + access token or password",
    configuredHint: "configured",
    unconfiguredHint: "needs auth",
    resolveConfigured: ({ cfg }) => resolveMatrixAccount({ cfg: cfg as CoreConfig }).configured,
    resolveStatusLines: ({ cfg }) => {
      const configured = resolveMatrixAccount({ cfg: cfg as CoreConfig }).configured;
      return [
        `Matrix: ${configured ? "configured" : "needs homeserver + access token or password"}`,
      ];
    },
    resolveSelectionHint: ({ cfg, configured }) => {
      if (!isMatrixSdkAvailable()) {
        return "install @vector-im/matrix-bot-sdk";
      }
      return configured ? "configured" : "needs auth";
    },
  },
  credentials: [],
  finalize: async ({ cfg, runtime, prompter, forceAllowFrom }) => {
    let next = cfg as CoreConfig;
    await ensureMatrixSdkInstalled({
      runtime,
      confirm: async (message) =>
        await prompter.confirm({
          message,
          initialValue: true,
        }),
    });
    const existing = next.channels?.matrix ?? {};
    const account = resolveMatrixAccount({ cfg: next });
    if (!account.configured) {
      await noteMatrixAuthHelp(prompter);
    }

    const envHomeserver = process.env.MATRIX_HOMESERVER?.trim();
    const envUserId = process.env.MATRIX_USER_ID?.trim();
    const envAccessToken = process.env.MATRIX_ACCESS_TOKEN?.trim();
    const envPassword = process.env.MATRIX_PASSWORD?.trim();
    const envReady = Boolean(envHomeserver && (envAccessToken || (envUserId && envPassword)));

    if (
      envReady &&
      !existing.homeserver &&
      !existing.userId &&
      !existing.accessToken &&
      !existing.password
    ) {
      const useEnv = await prompter.confirm({
        message: "Matrix env vars detected. Use env values?",
        initialValue: true,
      });
      if (useEnv) {
        next = matrixSetupAdapter.applyAccountConfig({
          cfg: next,
          accountId: DEFAULT_ACCOUNT_ID,
          input: { useEnv: true },
        }) as CoreConfig;
        if (forceAllowFrom) {
          next = await promptMatrixAllowFrom({ cfg: next, prompter });
        }
        return { cfg: next };
      }
    }

    const homeserver = String(
      await prompter.text({
        message: "Matrix homeserver URL",
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
    let password: SecretInput | undefined = existing.password;
    let userId = existing.userId ?? "";
    const existingPasswordConfigured = hasConfiguredSecretInput(existing.password);
    const passwordConfigured = () => hasConfiguredSecretInput(password);

    if (accessToken || passwordConfigured()) {
      const keep = await prompter.confirm({
        message: "Matrix credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        accessToken = "";
        password = undefined;
        userId = "";
      }
    }

    if (!accessToken && !passwordConfigured()) {
      const authMode = await prompter.select({
        message: "Matrix auth method",
        options: [
          { value: "token", label: "Access token (user ID fetched automatically)" },
          { value: "password", label: "Password (requires user ID)" },
        ],
      });

      if (authMode === "token") {
        accessToken = String(
          await prompter.text({
            message: "Matrix access token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        userId = "";
      } else {
        userId = String(
          await prompter.text({
            message: "Matrix user ID",
            initialValue: existing.userId ?? envUserId,
            validate: (value) => {
              const raw = String(value ?? "").trim();
              if (!raw) {
                return "Required";
              }
              if (!raw.startsWith("@")) {
                return "Matrix user IDs should start with @";
              }
              if (!raw.includes(":")) {
                return "Matrix user IDs should include a server (:server)";
              }
              return undefined;
            },
          }),
        ).trim();
        const passwordPromptState = buildSingleChannelSecretPromptState({
          accountConfigured: Boolean(existingPasswordConfigured),
          hasConfigToken: existingPasswordConfigured,
          allowEnv: true,
          envValue: envPassword,
        });
        const passwordResult = await promptSingleChannelSecretInput({
          cfg: next,
          prompter,
          providerHint: channel,
          credentialLabel: "password",
          accountConfigured: passwordPromptState.accountConfigured,
          canUseEnv: passwordPromptState.canUseEnv,
          hasConfigToken: passwordPromptState.hasConfigToken,
          envPrompt: "MATRIX_PASSWORD detected. Use env var?",
          keepPrompt: "Matrix password already configured. Keep it?",
          inputPrompt: "Matrix password",
          preferredEnvVar: "MATRIX_PASSWORD",
        });
        if (passwordResult.action === "set") {
          password = passwordResult.value;
        }
        if (passwordResult.action === "use-env") {
          password = undefined;
        }
      }
    }

    const deviceName = String(
      await prompter.text({
        message: "Matrix device name (optional)",
        initialValue: existing.deviceName ?? "OpenClaw Gateway",
      }),
    ).trim();

    const enableEncryption = await prompter.confirm({
      message: "Enable end-to-end encryption (E2EE)?",
      initialValue: existing.encryption ?? false,
    });

    next = {
      ...next,
      channels: {
        ...next.channels,
        matrix: {
          ...next.channels?.matrix,
          enabled: true,
          homeserver,
          userId: userId || undefined,
          accessToken: accessToken || undefined,
          password,
          deviceName: deviceName || undefined,
          encryption: enableEncryption || undefined,
        },
      },
    };

    if (forceAllowFrom) {
      next = await promptMatrixAllowFrom({ cfg: next, prompter });
    }

    const existingGroups = next.channels?.matrix?.groups ?? next.channels?.matrix?.rooms;
    const accessConfig = await promptChannelAccessConfig({
      prompter,
      label: "Matrix rooms",
      currentPolicy: next.channels?.matrix?.groupPolicy ?? "allowlist",
      currentEntries: Object.keys(existingGroups ?? {}),
      placeholder: "!roomId:server, #alias:server, Project Room",
      updatePrompt: Boolean(existingGroups),
    });
    if (accessConfig) {
      if (accessConfig.policy !== "allowlist") {
        next = setMatrixGroupPolicy(next, accessConfig.policy);
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
              const matches = await listMatrixDirectoryGroupsLive({
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
            const resolution = formatResolvedUnresolvedNote({
              resolved: resolvedIds,
              unresolved,
            });
            if (resolution) {
              await prompter.note(resolution, "Matrix rooms");
            }
          } catch (err) {
            await prompter.note(
              `Room lookup failed; keeping entries as typed. ${String(err)}`,
              "Matrix rooms",
            );
          }
        }
        next = setMatrixGroupPolicy(next, "allowlist");
        next = setMatrixGroupRooms(next, roomKeys);
      }
    }

    return { cfg: next };
  },
  dmPolicy: matrixDmPolicy,
  disable: (cfg) => ({
    ...(cfg as CoreConfig),
    channels: {
      ...(cfg as CoreConfig).channels,
      matrix: { ...(cfg as CoreConfig).channels?.matrix, enabled: false },
    },
  }),
};
