// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The OpenClaw Authors.

import type { DlpAction, DlpEntityType } from "./dlp/scanner.js";

export type GovernancePluginConfig = {
  enabled: boolean;
  storeDir?: string;
  aibom: {
    enabled: boolean;
    signingAlgorithm: "ed25519";
  };
  dlp: {
    enabled: boolean;
    defaultAction: DlpAction;
    entities?: DlpEntityType[];
    perChannel: Record<string, DlpAction>;
  };
  cost: {
    enabled: boolean;
    estimateFromChars: boolean;
    pricesPerMillion: Record<string, { inputUsd: number; outputUsd: number }>;
  };
};

const DEFAULT_CONFIG: GovernancePluginConfig = {
  enabled: true,
  aibom: { enabled: true, signingAlgorithm: "ed25519" },
  dlp: {
    enabled: true,
    defaultAction: "log",
    perChannel: {},
  },
  cost: {
    enabled: true,
    estimateFromChars: true,
    pricesPerMillion: {},
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function coerceString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function coerceAction(value: unknown, fallback: DlpAction): DlpAction {
  if (value === "log" || value === "warn" || value === "redact" || value === "block") {
    return value;
  }
  return fallback;
}

function coerceEntities(value: unknown): DlpEntityType[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const allowed: DlpEntityType[] = [
    "US_SSN",
    "CREDIT_CARD",
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "US_PASSPORT",
    "IBAN_CODE",
    "IP_ADDRESS",
    "US_DRIVER_LICENSE",
  ];
  const out: DlpEntityType[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && (allowed as string[]).includes(entry)) {
      out.push(entry as DlpEntityType);
    }
  }
  return out.length > 0 ? out : undefined;
}

function coercePerChannel(value: unknown): Record<string, DlpAction> {
  if (!isPlainObject(value)) {
    return {};
  }
  const out: Record<string, DlpAction> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === "log" || raw === "warn" || raw === "redact" || raw === "block") {
      out[key] = raw;
    }
  }
  return out;
}

function coercePrices(value: unknown): Record<string, { inputUsd: number; outputUsd: number }> {
  if (!isPlainObject(value)) {
    return {};
  }
  const out: Record<string, { inputUsd: number; outputUsd: number }> = {};
  for (const [model, raw] of Object.entries(value)) {
    if (!isPlainObject(raw)) {
      continue;
    }
    const inputUsd = typeof raw.inputUsd === "number" && raw.inputUsd >= 0 ? raw.inputUsd : null;
    const outputUsd =
      typeof raw.outputUsd === "number" && raw.outputUsd >= 0 ? raw.outputUsd : null;
    if (inputUsd === null || outputUsd === null) {
      continue;
    }
    out[model] = { inputUsd, outputUsd };
  }
  return out;
}

export function normalizeGovernanceConfig(raw: unknown): GovernancePluginConfig {
  if (!isPlainObject(raw)) {
    return { ...DEFAULT_CONFIG };
  }
  const aibomRaw = isPlainObject(raw.aibom) ? raw.aibom : {};
  const dlpRaw = isPlainObject(raw.dlp) ? raw.dlp : {};
  const costRaw = isPlainObject(raw.cost) ? raw.cost : {};
  const storeDir = coerceString(raw.storeDir);
  const config: GovernancePluginConfig = {
    enabled: coerceBoolean(raw.enabled, DEFAULT_CONFIG.enabled),
    ...(storeDir ? { storeDir } : {}),
    aibom: {
      enabled: coerceBoolean(aibomRaw.enabled, DEFAULT_CONFIG.aibom.enabled),
      signingAlgorithm: "ed25519",
    },
    dlp: {
      enabled: coerceBoolean(dlpRaw.enabled, DEFAULT_CONFIG.dlp.enabled),
      defaultAction: coerceAction(dlpRaw.defaultAction, DEFAULT_CONFIG.dlp.defaultAction),
      ...(coerceEntities(dlpRaw.entities) ? { entities: coerceEntities(dlpRaw.entities) } : {}),
      perChannel: coercePerChannel(dlpRaw.perChannel),
    },
    cost: {
      enabled: coerceBoolean(costRaw.enabled, DEFAULT_CONFIG.cost.enabled),
      estimateFromChars: coerceBoolean(
        costRaw.estimateFromChars,
        DEFAULT_CONFIG.cost.estimateFromChars,
      ),
      pricesPerMillion: coercePrices(costRaw.pricesPerMillion),
    },
  };
  return config;
}
