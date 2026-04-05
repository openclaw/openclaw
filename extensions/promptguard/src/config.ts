import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInput,
} from "openclaw/plugin-sdk/secret-input";
import { DEFAULT_BASE_URL } from "./guard-client.js";

export type PromptGuardMode = "enforce" | "monitor";

export type PromptGuardConfig = {
  apiKey: string;
  baseUrl: string;
  mode: PromptGuardMode;
  scanInputs: boolean;
  scanToolArgs: boolean;
  redactPii: boolean;
  detectors: string[];
};

const ALL_DETECTORS = [
  "prompt-injection",
  "data-exfiltration",
  "code-injection",
  "pii",
  "credit-card",
  "toxicity",
];

type PluginSecurityConfig = {
  apiKey?: unknown;
  baseUrl?: string;
  mode?: string;
  scanInputs?: boolean;
  scanToolArgs?: boolean;
  redactPii?: boolean;
  detectors?: string[];
};

type PluginEntryConfig = {
  security?: PluginSecurityConfig;
};

function resolvePluginConfig(cfg?: OpenClawConfig): PluginSecurityConfig | undefined {
  const pluginConfig = cfg?.plugins?.entries?.promptguard?.config as PluginEntryConfig | undefined;
  return pluginConfig?.security;
}

function resolveSecret(value: unknown, path: string): string | undefined {
  return normalizeSecretInput(normalizeResolvedSecretInputString({ value, path }));
}

export function resolvePromptGuardApiKey(cfg?: OpenClawConfig): string | undefined {
  const sec = resolvePluginConfig(cfg);
  return (
    resolveSecret(sec?.apiKey, "plugins.entries.promptguard.config.security.apiKey") ||
    normalizeSecretInput(process.env.PROMPTGUARD_API_KEY) ||
    undefined
  );
}

export function resolvePromptGuardConfig(cfg?: OpenClawConfig): PromptGuardConfig | null {
  const apiKey = resolvePromptGuardApiKey(cfg);
  if (!apiKey) return null;

  const sec = resolvePluginConfig(cfg);

  const baseUrl =
    (typeof sec?.baseUrl === "string" ? sec.baseUrl.trim() : "") ||
    normalizeSecretInput(process.env.PROMPTGUARD_BASE_URL) ||
    DEFAULT_BASE_URL;

  const mode: PromptGuardMode =
    sec?.mode === "enforce" || sec?.mode === "monitor" ? sec.mode : "monitor";

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    mode,
    scanInputs: sec?.scanInputs !== false,
    scanToolArgs: sec?.scanToolArgs !== false,
    redactPii: sec?.redactPii === true,
    detectors:
      Array.isArray(sec?.detectors) && sec.detectors.length > 0 ? sec.detectors : ALL_DETECTORS,
  };
}
