import type { OpenClawConfig } from "../config/config.js";

export type ContextBudget = {
  enabled: boolean;
  bootstrapMaxChars?: number;
  memoryMaxInjectedChars?: number;
  webFetchMaxChars?: number;
};

export function resolveContextBudget(cfg?: OpenClawConfig): ContextBudget {
  const raw = cfg?.agents?.defaults?.contextBudget;
  if (!raw || typeof raw !== "object") {
    return { enabled: false };
  }
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : false;

  const readPosInt = (v: unknown): number | undefined => {
    if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
    const n = Math.floor(v);
    return n > 0 ? n : undefined;
  };

  return {
    enabled,
    bootstrapMaxChars: readPosInt((raw as any).bootstrapMaxChars),
    memoryMaxInjectedChars: readPosInt((raw as any).memoryMaxInjectedChars),
    webFetchMaxChars: readPosInt((raw as any).webFetchMaxChars),
  };
}

export function maybeClampMaxChars(params: {
  configured: number;
  budget?: number;
  enabled: boolean;
}): number {
  if (!params.enabled) return params.configured;
  if (typeof params.budget !== "number" || !Number.isFinite(params.budget) || params.budget <= 0) {
    return params.configured;
  }
  return Math.min(params.configured, Math.floor(params.budget));
}
