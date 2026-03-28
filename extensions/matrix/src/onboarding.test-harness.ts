import type { OutputRuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { afterEach, vi } from "vitest";
import type { RuntimeEnv, WizardPrompter } from "../runtime-api.js";
import type { CoreConfig } from "./types.js";

const MATRIX_ENV_KEYS = [
  "MATRIX_HOMESERVER",
  "MATRIX_USER_ID",
  "MATRIX_ACCESS_TOKEN",
  "MATRIX_PASSWORD",
  "MATRIX_DEVICE_ID",
  "MATRIX_DEVICE_NAME",
  "MATRIX_OPS_HOMESERVER",
  "MATRIX_OPS_ACCESS_TOKEN",
] as const;

const previousMatrixEnv = Object.fromEntries(
  MATRIX_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof MATRIX_ENV_KEYS)[number], string | undefined>;

function createNonExitingTypedRuntimeEnv<TRuntime>(): TRuntime {
  return {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  } as OutputRuntimeEnv as TRuntime;
}

export function installMatrixOnboardingEnvRestoreHooks() {
  afterEach(() => {
    for (const [key, value] of Object.entries(previousMatrixEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

type PromptHandler<T> = (message: string) => T;

export function createMatrixWizardPrompter(params: {
  notes?: string[];
  select?: Record<string, string>;
  text?: Record<string, string>;
  confirm?: Record<string, boolean>;
  onNote?: PromptHandler<void | Promise<void>>;
  onSelect?: PromptHandler<string | Promise<string>>;
  onText?: PromptHandler<string | Promise<string>>;
  onConfirm?: PromptHandler<boolean | Promise<boolean>>;
}): WizardPrompter {
  const resolvePromptValue = async <T>(
    kind: string,
    message: string,
    values: Record<string, T> | undefined,
    fallback: PromptHandler<T | Promise<T>> | undefined,
  ): Promise<T> => {
    if (values && message in values) {
      return values[message] as T;
    }
    if (fallback) {
      return await fallback(message);
    }
    throw new Error(`unexpected ${kind} prompt: ${message}`);
  };

  return {
    note: vi.fn(async (message: unknown) => {
      const text = String(message);
      params.notes?.push(text);
      await params.onNote?.(text);
    }),
    select: vi.fn(async ({ message }: { message: string }) => {
      return await resolvePromptValue("select", message, params.select, params.onSelect);
    }),
    text: vi.fn(async ({ message }: { message: string }) => {
      return await resolvePromptValue("text", message, params.text, params.onText);
    }),
    confirm: vi.fn(async ({ message }: { message: string }) => {
      return await resolvePromptValue("confirm", message, params.confirm, params.onConfirm);
    }),
  } as unknown as WizardPrompter;
}

export async function runMatrixInteractiveConfigure(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  options?: unknown;
  accountOverrides?: Record<string, string>;
  shouldPromptAccountIds?: boolean;
  forceAllowFrom?: boolean;
  configured?: boolean;
}) {
  const { matrixOnboardingAdapter } = await import("./onboarding.js");
  return await matrixOnboardingAdapter.configureInteractive!({
    cfg: params.cfg,
    runtime: createNonExitingTypedRuntimeEnv<RuntimeEnv>(),
    prompter: params.prompter,
    options: params.options,
    accountOverrides: params.accountOverrides ?? {},
    shouldPromptAccountIds: params.shouldPromptAccountIds ?? false,
    forceAllowFrom: params.forceAllowFrom ?? false,
    configured: params.configured ?? false,
    label: "Matrix",
  });
}

export async function runMatrixAddAccountAllowlistConfigure(params: {
  cfg: CoreConfig;
  allowFromInput: string;
  roomsAllowlistInput: string;
  deviceName?: string;
}) {
  const prompter = createMatrixWizardPrompter({
    select: {
      "Matrix already configured. What do you want to do?": "add-account",
      "Matrix auth method": "token",
      "Matrix rooms access": "allowlist",
    },
    text: {
      "Matrix account name": "ops",
      "Matrix homeserver URL": "https://matrix.ops.example.org",
      "Matrix access token": "ops-token",
      "Matrix device name (optional)": params.deviceName ?? "",
      "Matrix allowFrom (full @user:server; display name only if unique)": params.allowFromInput,
      "Matrix rooms allowlist (comma-separated)": params.roomsAllowlistInput,
    },
    confirm: {
      "Enable end-to-end encryption (E2EE)?": false,
      "Configure Matrix rooms access?": true,
    },
    onConfirm: async () => false,
  });

  return await runMatrixInteractiveConfigure({
    cfg: params.cfg,
    prompter,
    shouldPromptAccountIds: true,
    forceAllowFrom: true,
    configured: true,
  });
}
