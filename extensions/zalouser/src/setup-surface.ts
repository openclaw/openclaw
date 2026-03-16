import type { ChannelOnboardingDmPolicy } from "../../../src/channels/plugins/onboarding-types.js";
import {
  mergeAllowFromEntries,
  setTopLevelChannelDmPolicyWithAllowFrom,
} from "../../../src/channels/plugins/onboarding/helpers.js";
import {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  migrateBaseNameToDefaultAccount,
  patchScopedAccountConfig,
} from "../../../src/channels/plugins/setup-helpers.js";
import type { ChannelSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import type { ChannelSetupAdapter } from "../../../src/channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { formatResolvedUnresolvedNote } from "../../../src/plugin-sdk/resolution-notes.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../src/routing/session-key.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import {
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
  checkZcaAuthenticated,
} from "./accounts.js";
import { writeQrDataUrlToTempFile } from "./qr-temp-file.js";
import {
  logoutZaloProfile,
  resolveZaloAllowFromEntries,
  resolveZaloGroupsByEntries,
  startZaloQrLogin,
  waitForZaloQrLogin,
} from "./zalo-js.js";

const channel = "zalouser" as const;

function setZalouserAccountScopedConfig(
  cfg: OpenClawConfig,
  accountId: string,
  defaultPatch: Record<string, unknown>,
  accountPatch: Record<string, unknown> = defaultPatch,
): OpenClawConfig {
  return patchScopedAccountConfig({
    cfg,
    channelKey: channel,
    accountId,
    patch: defaultPatch,
    accountPatch,
  }) as OpenClawConfig;
}

function setZalouserDmPolicy(
  cfg: OpenClawConfig,
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled",
): OpenClawConfig {
  return setTopLevelChannelDmPolicyWithAllowFrom({
    cfg,
    channel,
    dmPolicy,
  }) as OpenClawConfig;
}

function setZalouserGroupPolicy(
  cfg: OpenClawConfig,
  accountId: string,
  groupPolicy: "open" | "allowlist" | "disabled",
): OpenClawConfig {
  return setZalouserAccountScopedConfig(cfg, accountId, {
    groupPolicy,
  });
}

function setZalouserGroupAllowlist(
  cfg: OpenClawConfig,
  accountId: string,
  groupKeys: string[],
): OpenClawConfig {
  const groups = Object.fromEntries(groupKeys.map((key) => [key, { allow: true }]));
  return setZalouserAccountScopedConfig(cfg, accountId, {
    groups,
  });
}

async function noteZalouserHelp(
  prompter: Parameters<NonNullable<ChannelSetupWizard["prepare"]>>[0]["prompter"],
): Promise<void> {
  await prompter.note(
    [
      "Zalo Personal Account login via QR code.",
      "",
      "This plugin uses zca-js directly (no external CLI dependency).",
      "",
      `Docs: ${formatDocsLink("/channels/zalouser", "zalouser")}`,
    ].join("\n"),
    "Zalo Personal Setup",
  );
}

async function promptZalouserAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: Parameters<NonNullable<ChannelOnboardingDmPolicy["promptAllowFrom"]>>[0]["prompter"];
  accountId: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveZalouserAccountSync({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  const parseInput = (raw: string) =>
    raw
      .split(/[\n,;]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);

  while (true) {
    const entry = await prompter.text({
      message: "Zalouser allowFrom (name or user id)",
      placeholder: "Alice, 123456789",
      initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = parseInput(String(entry));
    const resolvedEntries = await resolveZaloAllowFromEntries({
      profile: resolved.profile,
      entries: parts,
    });

    const unresolved = resolvedEntries.filter((item) => !item.resolved).map((item) => item.input);
    if (unresolved.length > 0) {
      await prompter.note(
        `Could not resolve: ${unresolved.join(", ")}. Use numeric user ids or exact friend names.`,
        "Zalo Personal allowlist",
      );
      continue;
    }

    const resolvedIds = resolvedEntries
      .filter((item) => item.resolved && item.id)
      .map((item) => item.id as string);
    const unique = mergeAllowFromEntries(existingAllowFrom, resolvedIds);

    const notes = resolvedEntries
      .filter((item) => item.note)
      .map((item) => `${item.input} -> ${item.id} (${item.note})`);
    if (notes.length > 0) {
      await prompter.note(notes.join("\n"), "Zalo Personal allowlist");
    }

    return setZalouserAccountScopedConfig(cfg, accountId, {
      dmPolicy: "allowlist",
      allowFrom: unique,
    });
  }
}

const zalouserDmPolicy: ChannelOnboardingDmPolicy = {
  label: "Zalo Personal",
  channel,
  policyKey: "channels.zalouser.dmPolicy",
  allowFromKey: "channels.zalouser.allowFrom",
  getCurrent: (cfg) => (cfg.channels?.zalouser?.dmPolicy ?? "pairing") as "pairing",
  setPolicy: (cfg, policy) => setZalouserDmPolicy(cfg as OpenClawConfig, policy),
  promptAllowFrom: async ({ cfg, prompter, accountId }) => {
    const id =
      accountId && normalizeAccountId(accountId)
        ? (normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID)
        : resolveDefaultZalouserAccountId(cfg as OpenClawConfig);
    return await promptZalouserAllowFrom({
      cfg: cfg as OpenClawConfig,
      prompter,
      accountId: id,
    });
  },
};

export const zalouserSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: () => null,
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name: input.name,
    });
    const next =
      accountId !== DEFAULT_ACCOUNT_ID
        ? migrateBaseNameToDefaultAccount({
            cfg: namedConfig,
            channelKey: channel,
          })
        : namedConfig;
    return applySetupAccountConfigPatch({
      cfg: next,
      channelKey: channel,
      accountId,
      patch: {},
    });
  },
};

export const zalouserSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    configuredLabel: "logged in",
    unconfiguredLabel: "needs QR login",
    configuredHint: "recommended · logged in",
    unconfiguredHint: "recommended · QR login",
    configuredScore: 1,
    unconfiguredScore: 15,
    resolveConfigured: async ({ cfg }) => {
      const ids = listZalouserAccountIds(cfg);
      for (const accountId of ids) {
        const account = resolveZalouserAccountSync({ cfg, accountId });
        if (await checkZcaAuthenticated(account.profile)) {
          return true;
        }
      }
      return false;
    },
    resolveStatusLines: async ({ cfg, configured }) => {
      void cfg;
      return [`Zalo Personal: ${configured ? "logged in" : "needs QR login"}`];
    },
  },
  prepare: async ({ cfg, accountId, prompter }) => {
    let next = cfg;
    const account = resolveZalouserAccountSync({ cfg: next, accountId });
    const alreadyAuthenticated = await checkZcaAuthenticated(account.profile);

    if (!alreadyAuthenticated) {
      await noteZalouserHelp(prompter);
      const wantsLogin = await prompter.confirm({
        message: "Login via QR code now?",
        initialValue: true,
      });

      if (wantsLogin) {
        const start = await startZaloQrLogin({ profile: account.profile, timeoutMs: 35_000 });
        if (start.qrDataUrl) {
          const qrPath = await writeQrDataUrlToTempFile(start.qrDataUrl, account.profile);
          await prompter.note(
            [
              start.message,
              qrPath
                ? `QR image saved to: ${qrPath}`
                : "Could not write QR image file; use gateway web login UI instead.",
              "Scan + approve on phone, then continue.",
            ].join("\n"),
            "QR Login",
          );
          const scanned = await prompter.confirm({
            message: "Did you scan and approve the QR on your phone?",
            initialValue: true,
          });
          if (scanned) {
            const waited = await waitForZaloQrLogin({
              profile: account.profile,
              timeoutMs: 120_000,
            });
            await prompter.note(waited.message, waited.connected ? "Success" : "Login pending");
          }
        } else {
          await prompter.note(start.message, "Login pending");
        }
      }
    } else {
      const keepSession = await prompter.confirm({
        message: "Zalo Personal already logged in. Keep session?",
        initialValue: true,
      });
      if (!keepSession) {
        await logoutZaloProfile(account.profile);
        const start = await startZaloQrLogin({
          profile: account.profile,
          force: true,
          timeoutMs: 35_000,
        });
        if (start.qrDataUrl) {
          const qrPath = await writeQrDataUrlToTempFile(start.qrDataUrl, account.profile);
          await prompter.note(
            [start.message, qrPath ? `QR image saved to: ${qrPath}` : undefined]
              .filter(Boolean)
              .join("\n"),
            "QR Login",
          );
          const waited = await waitForZaloQrLogin({ profile: account.profile, timeoutMs: 120_000 });
          await prompter.note(waited.message, waited.connected ? "Success" : "Login pending");
        }
      }
    }

    next = setZalouserAccountScopedConfig(
      next,
      accountId,
      { profile: account.profile !== "default" ? account.profile : undefined },
      { profile: account.profile, enabled: true },
    );

    return { cfg: next };
  },
  credentials: [],
  groupAccess: {
    label: "Zalo groups",
    placeholder: "Family, Work, 123456789",
    currentPolicy: ({ cfg, accountId }) =>
      resolveZalouserAccountSync({ cfg, accountId }).config.groupPolicy ?? "allowlist",
    currentEntries: ({ cfg, accountId }) =>
      Object.keys(resolveZalouserAccountSync({ cfg, accountId }).config.groups ?? {}),
    updatePrompt: ({ cfg, accountId }) =>
      Boolean(resolveZalouserAccountSync({ cfg, accountId }).config.groups),
    setPolicy: ({ cfg, accountId, policy }) =>
      setZalouserGroupPolicy(cfg as OpenClawConfig, accountId, policy),
    resolveAllowlist: async ({ cfg, accountId, entries, prompter }) => {
      if (entries.length === 0) {
        return [];
      }
      const updatedAccount = resolveZalouserAccountSync({ cfg: cfg as OpenClawConfig, accountId });
      try {
        const resolved = await resolveZaloGroupsByEntries({
          profile: updatedAccount.profile,
          entries,
        });
        const resolvedIds = resolved
          .filter((entry) => entry.resolved && entry.id)
          .map((entry) => entry.id as string);
        const unresolved = resolved.filter((entry) => !entry.resolved).map((entry) => entry.input);
        const keys = [...resolvedIds, ...unresolved.map((entry) => entry.trim()).filter(Boolean)];
        const resolution = formatResolvedUnresolvedNote({
          resolved: resolvedIds,
          unresolved,
        });
        if (resolution) {
          await prompter.note(resolution, "Zalo groups");
        }
        return keys;
      } catch (err) {
        await prompter.note(
          `Group lookup failed; keeping entries as typed. ${String(err)}`,
          "Zalo groups",
        );
        return entries.map((entry) => entry.trim()).filter(Boolean);
      }
    },
    applyAllowlist: ({ cfg, accountId, resolved }) =>
      setZalouserGroupAllowlist(cfg as OpenClawConfig, accountId, resolved as string[]),
  },
  finalize: async ({ cfg, accountId, forceAllowFrom, prompter }) => {
    let next = cfg;
    if (forceAllowFrom) {
      next = await promptZalouserAllowFrom({
        cfg: next,
        prompter,
        accountId,
      });
    }
    return { cfg: next };
  },
  dmPolicy: zalouserDmPolicy,
};
