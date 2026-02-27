import fsp from "node:fs/promises";
import path from "node:path";
import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk";
import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  formatResolvedUnresolvedNote,
  mergeAllowFromEntries,
  normalizeAccountId,
  promptAccountId,
  promptChannelAccessConfig,
  resolvePreferredOpenClawTmpDir,
} from "openclaw/plugin-sdk";
import {
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
  checkZcaAuthenticated,
} from "./accounts.js";
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
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalouser: {
          ...cfg.channels?.zalouser,
          enabled: true,
          ...defaultPatch,
        },
      },
    } as OpenClawConfig;
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zalouser: {
        ...cfg.channels?.zalouser,
        enabled: true,
        accounts: {
          ...cfg.channels?.zalouser?.accounts,
          [accountId]: {
            ...cfg.channels?.zalouser?.accounts?.[accountId],
            enabled: cfg.channels?.zalouser?.accounts?.[accountId]?.enabled ?? true,
            ...accountPatch,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function setZalouserDmPolicy(
  cfg: OpenClawConfig,
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled",
): OpenClawConfig {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.zalouser?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zalouser: {
        ...cfg.channels?.zalouser,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  } as OpenClawConfig;
}

async function noteZalouserHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Zalo Personal Account login via QR code.",
      "",
      "This plugin uses zca-js directly (no external CLI dependency).",
      "",
      "Docs: https://docs.openclaw.ai/channels/zalouser",
    ].join("\n"),
    "Zalo Personal Setup",
  );
}

async function writeQrDataUrlToTempFile(
  qrDataUrl: string,
  profile: string,
): Promise<string | null> {
  const trimmed = qrDataUrl.trim();
  const match = trimmed.match(/^data:image\/png;base64,(.+)$/i);
  const base64 = (match?.[1] ?? "").trim();
  if (!base64) {
    return null;
  }
  const safeProfile = profile.replace(/[^a-zA-Z0-9_-]+/g, "-") || "default";
  const filePath = path.join(
    resolvePreferredOpenClawTmpDir(),
    `openclaw-zalouser-qr-${safeProfile}.png`,
  );
  await fsp.writeFile(filePath, Buffer.from(base64, "base64"));
  return filePath;
}

async function promptZalouserAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
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

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Zalo Personal",
  channel,
  policyKey: "channels.zalouser.dmPolicy",
  allowFromKey: "channels.zalouser.allowFrom",
  getCurrent: (cfg) => (cfg.channels?.zalouser?.dmPolicy ?? "pairing") as "pairing",
  setPolicy: (cfg, policy) => setZalouserDmPolicy(cfg, policy),
  promptAllowFrom: async ({ cfg, prompter, accountId }) => {
    const id =
      accountId && normalizeAccountId(accountId)
        ? (normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID)
        : resolveDefaultZalouserAccountId(cfg);
    return promptZalouserAllowFrom({
      cfg,
      prompter,
      accountId: id,
    });
  },
};

export const zalouserOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const ids = listZalouserAccountIds(cfg);
    let configured = false;
    for (const accountId of ids) {
      const account = resolveZalouserAccountSync({ cfg, accountId });
      const isAuth = await checkZcaAuthenticated(account.profile);
      if (isAuth) {
        configured = true;
        break;
      }
    }
    return {
      channel,
      configured,
      statusLines: [`Zalo Personal: ${configured ? "logged in" : "needs QR login"}`],
      selectionHint: configured ? "recommended · logged in" : "recommended · QR login",
      quickstartScore: configured ? 1 : 15,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    const zalouserOverride = accountOverrides.zalouser?.trim();
    const defaultAccountId = resolveDefaultZalouserAccountId(cfg);
    let accountId = zalouserOverride ? normalizeAccountId(zalouserOverride) : defaultAccountId;

    if (shouldPromptAccountIds && !zalouserOverride) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "Zalo Personal",
        currentId: accountId,
        listAccountIds: listZalouserAccountIds,
        defaultAccountId,
      });
    }

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

    if (forceAllowFrom) {
      next = await promptZalouserAllowFrom({
        cfg: next,
        prompter,
        accountId,
      });
    }

    const updatedAccount = resolveZalouserAccountSync({ cfg: next, accountId });
    const accessConfig = await promptChannelAccessConfig({
      prompter,
      label: "Zalo groups",
      currentPolicy: updatedAccount.config.groupPolicy ?? "allowlist",
      currentEntries: Object.keys(updatedAccount.config.groups ?? {}),
      placeholder: "Family, Work, 123456789",
      updatePrompt: Boolean(updatedAccount.config.groups),
    });

    if (accessConfig) {
      if (accessConfig.policy !== "allowlist") {
        next = setZalouserGroupPolicy(next, accountId, accessConfig.policy);
      } else {
        let keys = accessConfig.entries;
        if (accessConfig.entries.length > 0) {
          try {
            const resolved = await resolveZaloGroupsByEntries({
              profile: updatedAccount.profile,
              entries: accessConfig.entries,
            });
            const resolvedIds = resolved
              .filter((entry) => entry.resolved && entry.id)
              .map((entry) => entry.id as string);
            const unresolved = resolved
              .filter((entry) => !entry.resolved)
              .map((entry) => entry.input);
            keys = [...resolvedIds, ...unresolved.map((entry) => entry.trim()).filter(Boolean)];
            const resolution = formatResolvedUnresolvedNote({
              resolved: resolvedIds,
              unresolved,
            });
            if (resolution) {
              await prompter.note(resolution, "Zalo groups");
            }
          } catch (err) {
            await prompter.note(
              `Group lookup failed; keeping entries as typed. ${String(err)}`,
              "Zalo groups",
            );
          }
        }
        next = setZalouserGroupPolicy(next, accountId, "allowlist");
        next = setZalouserGroupAllowlist(next, accountId, keys);
      }
    }

    return { cfg: next, accountId };
  },
};
