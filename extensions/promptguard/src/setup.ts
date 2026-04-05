import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { PromptGuardClient } from "./guard-client.js";

const DETECTOR_OPTIONS = [
  { value: "prompt-injection", label: "Prompt Injection" },
  { value: "data-exfiltration", label: "Data Exfiltration" },
  { value: "code-injection", label: "Code Injection" },
  { value: "pii", label: "PII Detection" },
  { value: "credit-card", label: "Credit Card Numbers" },
  { value: "toxicity", label: "Toxicity / Harmful Content" },
] as const;

export type PromptGuardSetupResult = {
  config: OpenClawConfig;
};

export async function runPromptGuardSetup(
  prompter: WizardPrompter,
  config: OpenClawConfig,
): Promise<PromptGuardSetupResult> {
  let cfg = structuredClone(config);

  const apiKey = await prompter.text({
    message: "Enter your PromptGuard API key (get one at https://app.promptguard.co)",
    placeholder: "pg_...",
    validate: (v: string) => {
      if (!v.trim()) return "API key is required";
      return undefined;
    },
  });

  const client = new PromptGuardClient({ apiKey: apiKey.trim() });
  const healthy = await client.health();
  if (!healthy) {
    const proceed = await prompter.confirm({
      message: "Could not reach PromptGuard API. Continue with this key anyway?",
      initialValue: true,
    });
    if (!proceed) {
      return { config: cfg };
    }
  }

  const mode = await prompter.select({
    message: "Choose enforcement mode",
    options: [
      {
        value: "monitor" as const,
        label: "Monitor (log threats, don't block) -- recommended to start",
      },
      {
        value: "enforce" as const,
        label: "Enforce (block detected threats)",
      },
    ],
    initialValue: "monitor" as const,
  });

  const detectors = await prompter.multiselect({
    message: "Select threat detectors to enable",
    options: DETECTOR_OPTIONS.map((d) => ({
      value: d.value,
      label: d.label,
    })),
    initialValues: DETECTOR_OPTIONS.map((d) => d.value),
  });

  const redactPii = await prompter.confirm({
    message: "Enable automatic PII redaction on outgoing messages?",
    initialValue: false,
  });

  cfg = ensurePluginConfig(cfg, {
    apiKey: apiKey.trim(),
    mode: mode as string,
    detectors: detectors as string[],
    redactPii,
    scanInputs: true,
    scanToolArgs: true,
  });

  cfg = ensurePluginEnabled(cfg);

  return { config: cfg };
}

function ensurePluginConfig(
  cfg: OpenClawConfig,
  security: Record<string, unknown>,
): OpenClawConfig {
  const plugins = cfg.plugins ?? {};
  const entries = plugins.entries ?? {};
  const pg = entries.promptguard ?? {};

  return {
    ...cfg,
    plugins: {
      ...plugins,
      entries: {
        ...entries,
        promptguard: {
          ...pg,
          config: {
            ...((pg as Record<string, unknown>).config as Record<string, unknown> | undefined),
            security,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function ensurePluginEnabled(cfg: OpenClawConfig): OpenClawConfig {
  const plugins = cfg.plugins ?? {};
  const entries = plugins.entries ?? {};
  const pg = entries.promptguard ?? {};

  return {
    ...cfg,
    plugins: {
      ...plugins,
      entries: {
        ...entries,
        promptguard: {
          ...pg,
          enabled: true,
        },
      },
    },
  } as OpenClawConfig;
}
