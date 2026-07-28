import { renderQrPngBase64 } from "openclaw/plugin-sdk/media-runtime";
import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk/run-command";
import { WizardCancelledError, type WizardPrompter } from "openclaw/plugin-sdk/setup";
import type { ResolvedSignalTransport } from "./accounts.js";
import { normalizeSignalAccountInput } from "./setup-core.js";
import { resolveSignalCliConfigPath } from "./signal-cli-config-path.js";
import { linkSignalCliAccount } from "./signal-cli-link.js";
import { renderSignalLinkQr } from "./signal-link-qr.js";

type ResolvedManagedSignalTransport = Extract<ResolvedSignalTransport, { kind: "managed-native" }>;
type ManagedSignalAccountChoice = "link" | "stop" | `account:${string}`;
type ManagedSignalAccountSelectionMode = "reuse-only-account" | "choose";
export type ManagedSignalAccountResolution = {
  account: string;
  linked: boolean;
};

const SIGNAL_CLI_ACCOUNT_CHECK_TIMEOUT_MS = 10_000;

export async function resolveManagedSignalAccount(params: {
  transport: ResolvedManagedSignalTransport;
  configuredAccount?: string;
  selectionMode: ManagedSignalAccountSelectionMode;
  prompter: WizardPrompter;
  beforePersistentEffect?: () => Promise<void>;
  abortSignal?: AbortSignal;
  deferDeviceLinkToClient?: boolean;
  remoteWizard?: boolean;
}): Promise<ManagedSignalAccountResolution> {
  const listed = await listSignalCliAccounts(params.transport);
  if (!listed.ok) {
    throw new Error(listed.error);
  }
  if (params.selectionMode === "reuse-only-account" && listed.accounts.size === 1) {
    const account = listed.accounts.values().next().value;
    if (account && (!params.configuredAccount || account === params.configuredAccount)) {
      return { account, linked: true };
    }
  }
  if (listed.accounts.size === 0 && params.deferDeviceLinkToClient) {
    return {
      account: await promptDeferredSignalAccount(params.prompter, params.configuredAccount),
      linked: false,
    };
  }
  if (listed.accounts.size === 0 && params.remoteWizard && !params.prompter.qrCode) {
    throw new Error(
      "This setup client cannot display the Signal linking QR code. Update OpenClaw and retry, or run `openclaw configure --section channels` in a terminal.",
    );
  }

  const choice = await promptManagedSignalAccountChoice({
    accounts: listed.accounts,
    configuredAccount: params.configuredAccount,
    prompter: params.prompter,
    allowLink:
      !params.deferDeviceLinkToClient && (!params.remoteWizard || Boolean(params.prompter.qrCode)),
  });
  if (choice === "stop") {
    throw new WizardCancelledError("Signal setup stopped");
  }
  if (choice.startsWith("account:")) {
    return { account: choice.slice("account:".length), linked: true };
  }
  return {
    account: await linkManagedSignalAccount({
      transport: params.transport,
      accountsBeforeLink: listed.accounts,
      prompter: params.prompter,
      beforePersistentEffect: params.beforePersistentEffect,
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    }),
    linked: true,
  };
}

async function promptDeferredSignalAccount(
  prompter: WizardPrompter,
  configuredAccount?: string,
): Promise<string> {
  await prompter.note(
    [
      "This setup screen can save the Signal configuration, but it cannot link a Signal device.",
      "After this wizard finishes, run `openclaw configure --section channels` in a terminal to link the account.",
    ].join("\n"),
    "Signal account linking",
  );
  const input = await prompter.text({
    message: "Signal account number (E.164)",
    ...(configuredAccount ? { initialValue: configuredAccount } : {}),
    placeholder: "+15555550123",
    validate: (candidate) =>
      normalizeSignalAccountInput(candidate)
        ? undefined
        : "Enter a valid E.164 phone number, for example +15555550123.",
  });
  const account = normalizeSignalAccountInput(input);
  if (!account) {
    throw new Error("Signal setup requires a valid E.164 account number.");
  }
  return account;
}

async function promptManagedSignalAccountChoice(params: {
  accounts: Set<string>;
  configuredAccount?: string;
  prompter: WizardPrompter;
  allowLink: boolean;
}): Promise<ManagedSignalAccountChoice> {
  const accounts = [...params.accounts].toSorted();
  if (accounts.length === 0) {
    if (!params.allowLink) {
      throw new Error(
        "No linked Signal account was found. Link one from a terminal with `openclaw configure --section channels`, then retry.",
      );
    }
    return await params.prompter.select<"link" | "stop">({
      message: "No linked Signal account was found. How should setup continue?",
      options: [
        { value: "link", label: "Link a Signal account now" },
        { value: "stop", label: "Stop Signal setup" },
      ],
      initialValue: "link",
    });
  }
  return await params.prompter.select<ManagedSignalAccountChoice>({
    message: "Choose the linked Signal account for OpenClaw",
    options: [
      ...accounts.map((account) => ({
        value: `account:${account}` as const,
        label: account,
      })),
      ...(params.allowLink
        ? [{ value: "link" as const, label: "Link another Signal account" }]
        : []),
    ],
    initialValue: `account:${
      params.configuredAccount && params.accounts.has(params.configuredAccount)
        ? params.configuredAccount
        : accounts[0]
    }`,
  });
}

async function linkManagedSignalAccount(params: {
  transport: ResolvedManagedSignalTransport;
  accountsBeforeLink: Set<string>;
  prompter: WizardPrompter;
  beforePersistentEffect?: () => Promise<void>;
  abortSignal?: AbortSignal;
}): Promise<string> {
  let associatedAccountFromLink: string | undefined;
  while (true) {
    if (!params.prompter.qrCode) {
      await params.beforePersistentEffect?.();
    }
    const link = await linkSignalCliAccount({
      cliPath: params.transport.cliPath,
      ...(params.transport.configPath ? { configPath: params.transport.configPath } : {}),
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
      onLinkUri: async (uri, completion) => {
        const instructions =
          "On your phone, open Signal > Settings > Linked devices and add a device.";
        if (params.prompter.qrCode) {
          // Signal may persist the linked device as soon as the phone approves
          // this QR, so cancellation must lock before the code becomes visible.
          await params.beforePersistentEffect?.();
          const confirmed = await params.prompter.qrCode({
            title: "Signal account linking",
            message: [
              instructions,
              "Scan this QR code, approve the linked device in Signal, then choose Continue.",
            ].join("\n"),
            pngBase64: await renderQrPngBase64(uri),
            dismissWhen: completion,
          });
          if (!confirmed) {
            throw new Error("Signal account linking was not confirmed.");
          }
          await completion;
          return;
        }
        const qr = await renderSignalLinkQr(uri);
        const message = [
          instructions,
          "Scan this QR code:",
          "OpenClaw will continue automatically after Signal approves the linked device.",
          "",
          qr,
        ].join("\n");
        if (params.prompter.plain) {
          await params.prompter.plain(message);
        } else {
          await params.prompter.note(message, "Signal account linking");
        }
      },
    });
    if (link.ok) {
      associatedAccountFromLink = link.associatedAccount;
      break;
    }
    await params.prompter.note(
      `signal-cli could not link this device.\n\n${link.error}`,
      "Signal account linking",
    );
    const recovery = await params.prompter.select<"retry" | "stop">({
      message: "How should Signal account linking continue?",
      options: [
        { value: "retry", label: "Retry account linking" },
        { value: "stop", label: "Stop Signal setup" },
      ],
      initialValue: "retry",
    });
    if (recovery === "stop") {
      throw new WizardCancelledError("Signal setup stopped");
    }
  }

  const listed = await listSignalCliAccounts(params.transport);
  if (!listed.ok) {
    throw new Error(listed.error);
  }
  const associatedAccount = normalizeSignalAccountInput(associatedAccountFromLink);
  if (associatedAccount && listed.accounts.has(associatedAccount)) {
    return associatedAccount;
  }
  const newAccounts = [...listed.accounts].filter(
    (account) => !params.accountsBeforeLink.has(account),
  );
  if (newAccounts.length === 1 && newAccounts[0]) {
    return newAccounts[0];
  }
  throw new Error("signal-cli linked a device, but OpenClaw could not identify its account.");
}

async function listSignalCliAccounts(
  transport: ResolvedManagedSignalTransport,
): Promise<{ ok: true; accounts: Set<string> } | { ok: false; error: string }> {
  const configPath = transport.configPath?.trim();
  const result = await runPluginCommandWithTimeout({
    argv: [
      transport.cliPath,
      ...(configPath ? ["--config", resolveSignalCliConfigPath(configPath)] : []),
      "--output",
      "json",
      "listAccounts",
    ],
    timeoutMs: SIGNAL_CLI_ACCOUNT_CHECK_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    return {
      ok: false,
      error:
        `signal-cli could not list its linked accounts (exit ${result.code}). ` +
        "Check the signal-cli path and config path, then retry.",
    };
  }

  const linkedAccounts = parseSignalCliAccounts(result.stdout);
  if (!linkedAccounts) {
    return {
      ok: false,
      error:
        "signal-cli returned an unexpected account list. Check the signal-cli version and config path, then retry.",
    };
  }
  return { ok: true, accounts: linkedAccounts };
}

function parseSignalCliAccounts(stdout: string): Set<string> | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!Array.isArray(value)) {
      return undefined;
    }
    const accounts = new Set<string>();
    for (const entry of value) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("number" in entry) ||
        typeof entry.number !== "string"
      ) {
        return undefined;
      }
      const account = normalizeSignalAccountInput(entry.number);
      if (account) {
        accounts.add(account);
      }
    }
    return accounts;
  } catch {
    return undefined;
  }
}
