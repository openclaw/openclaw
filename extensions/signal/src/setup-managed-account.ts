import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk/run-command";
import { WizardCancelledError, type WizardPrompter } from "openclaw/plugin-sdk/setup";
import { resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";
import type { ResolvedSignalTransport } from "./accounts.js";
import { normalizeSignalAccountInput } from "./setup-core.js";
import { linkSignalCliAccount } from "./signal-cli-link.js";
import { renderSignalLinkQr } from "./signal-link-qr.js";

type ResolvedManagedSignalTransport = Extract<ResolvedSignalTransport, { kind: "managed-native" }>;
type ManagedSignalAccountChoice = "link" | "stop" | `account:${string}`;
type ManagedSignalAccountSelectionMode = "reuse-configured-or-only" | "choose";

const SIGNAL_CLI_ACCOUNT_CHECK_TIMEOUT_MS = 10_000;

export async function resolveManagedSignalAccount(params: {
  transport: ResolvedManagedSignalTransport;
  configuredAccount?: string;
  selectionMode: ManagedSignalAccountSelectionMode;
  prompter: WizardPrompter;
  beforePersistentEffect?: () => Promise<void>;
}): Promise<string> {
  const listed = await listSignalCliAccounts(params.transport);
  if (!listed.ok) {
    throw new Error(listed.error);
  }
  if (params.configuredAccount && listed.accounts.has(params.configuredAccount)) {
    return params.configuredAccount;
  }
  if (
    params.selectionMode === "reuse-configured-or-only" &&
    !params.configuredAccount &&
    listed.accounts.size === 1
  ) {
    const account = listed.accounts.values().next().value;
    if (account) {
      return account;
    }
  }

  const choice = await promptManagedSignalAccountChoice({
    accounts: listed.accounts,
    prompter: params.prompter,
  });
  if (choice === "stop") {
    throw new WizardCancelledError("Signal setup stopped");
  }
  if (choice.startsWith("account:")) {
    return choice.slice("account:".length);
  }
  return await linkManagedSignalAccount({
    transport: params.transport,
    accountsBeforeLink: listed.accounts,
    prompter: params.prompter,
    beforePersistentEffect: params.beforePersistentEffect,
  });
}

async function promptManagedSignalAccountChoice(params: {
  accounts: Set<string>;
  prompter: WizardPrompter;
}): Promise<ManagedSignalAccountChoice> {
  const accounts = [...params.accounts];
  if (accounts.length === 0) {
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
      { value: "link", label: "Link another Signal account" },
    ],
    initialValue: `account:${accounts[0]}`,
  });
}

async function linkManagedSignalAccount(params: {
  transport: ResolvedManagedSignalTransport;
  accountsBeforeLink: Set<string>;
  prompter: WizardPrompter;
  beforePersistentEffect?: () => Promise<void>;
}): Promise<string> {
  let associatedAccountFromLink: string | undefined;
  while (true) {
    await params.beforePersistentEffect?.();
    const link = await linkSignalCliAccount({
      cliPath: params.transport.cliPath,
      ...(params.transport.configPath ? { configPath: params.transport.configPath } : {}),
      onLinkUri: async (uri) => {
        const qr = await renderSignalLinkQr(uri);
        await params.prompter.plain?.(
          [
            "On your phone, open Signal > Settings > Linked devices and add a device.",
            "Scan this QR code:",
            "OpenClaw will continue automatically after Signal approves the linked device.",
            "",
            qr,
          ].join("\n"),
        );
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
      ...(configPath ? ["--config", resolveUserPath(configPath)] : []),
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
