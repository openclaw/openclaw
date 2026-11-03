// Matrix setup module handles plugin onboarding behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, vi } from "vitest";
import type { WizardPrompter } from "../runtime-api.js";
import type { CoreConfig, MatrixConfig } from "./types.js";

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

export const matrixConfig = (matrix: MatrixConfig): CoreConfig => ({ channels: { matrix } });

export function installMatrixOnboardingEnvRestoreHooks() {
  afterEach(() => {
    // Restore only the fixed Matrix allowlist; never replay arbitrary keys into host env.
    for (const key of MATRIX_ENV_KEYS) {
      const value = previousMatrixEnv[key];
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
      return expectDefined(values[message], `${kind} prompt value for ${message}`);
    }
    if (fallback) {
      return await fallback(message);
    }
    throw new Error(`unexpected ${kind} prompt: ${message}`);
  };

  return {
    note: vi.fn(async (message: unknown) => {
      params.notes?.push(String(message));
    }),
    select: vi.fn(
      async ({ message }: { message: string }) =>
        await resolvePromptValue("select", message, params.select, undefined),
    ),
    text: vi.fn(
      async ({ message }: { message: string }) =>
        await resolvePromptValue("text", message, params.text, params.onText),
    ),
    confirm: vi.fn(
      async ({ message }: { message: string }) =>
        await resolvePromptValue("confirm", message, params.confirm, params.onConfirm),
    ),
  } as unknown as WizardPrompter;
}

export function installMatrixScopedEnvShortcut() {
  process.env.MATRIX_HOMESERVER = "https://matrix.env.example.org";
  process.env.MATRIX_USER_ID = "@env:example.org";
  process.env.MATRIX_PASSWORD = "env-password"; // pragma: allowlist secret
  process.env.MATRIX_ACCESS_TOKEN = "";
  process.env.MATRIX_OPS_HOMESERVER = "https://matrix.ops.env.example.org";
  process.env.MATRIX_OPS_ACCESS_TOKEN = "ops-env-token";
}

export async function runMatrixInteractiveConfigure(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  shouldPromptAccountIds?: boolean;
  forceAllowFrom?: boolean;
  configured?: boolean;
}) {
  const { matrixOnboardingAdapter } = await import("./onboarding.js");
  return await matrixOnboardingAdapter.configureInteractive!({
    cfg: params.cfg,
    runtime: createNonExitingRuntimeEnv(),
    prompter: params.prompter,
    options: undefined,
    accountOverrides: {},
    shouldPromptAccountIds: params.shouldPromptAccountIds ?? false,
    forceAllowFrom: params.forceAllowFrom ?? false,
    configured: params.configured ?? false,
    label: "Matrix",
  });
}

export function createConfiguredMatrixTopLevelConfig(params?: {
  accessToken?: string | { source: "env"; provider: "default"; id: string };
  autoJoin?: "allowlist" | "off";
  autoJoinAllowlist?: string[];
}): CoreConfig {
  return matrixConfig({
    homeserver: "https://matrix.example.org",
    accessToken: params?.accessToken ?? "matrix-token",
    ...(params?.autoJoin ? { autoJoin: params.autoJoin } : {}),
    ...(params?.autoJoinAllowlist ? { autoJoinAllowlist: params.autoJoinAllowlist } : {}),
  });
}

export function createMatrixUpdateKeepCredentialsPrompter(params?: {
  notes?: string[];
  inviteAutoJoin?: "off" | "allowlist";
  onText?: PromptHandler<string | Promise<string>>;
}) {
  return createMatrixWizardPrompter({
    notes: params?.notes,
    select: {
      "Matrix already configured. What do you want to do?": "update",
      ...(params?.inviteAutoJoin ? { "Matrix invite auto-join": params.inviteAutoJoin } : {}),
    },
    text: {
      "Matrix homeserver URL": "https://matrix.example.org",
      "Matrix device name (optional)": "OpenClaw Gateway",
    },
    confirm: {
      "Matrix credentials already configured. Keep them?": true,
      "Enable end-to-end encryption (E2EE)?": false,
      "Configure Matrix rooms access?": false,
      "Configure Matrix invite auto-join?": params?.inviteAutoJoin !== undefined,
      ...(params?.inviteAutoJoin !== undefined ? { "Update Matrix invite auto-join?": true } : {}),
    },
    ...(params?.onText ? { onText: params.onText } : {}),
  });
}
