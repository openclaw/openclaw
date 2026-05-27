import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";

export type OwnerDisplaySetting = {
  ownerDisplay?: "raw" | "hash";
  ownerDisplaySecret?: string;
};

export type OwnerDisplaySecretResolution = {
  config: OpenClawConfig;
  generatedSecret?: string;
};

function trimToUndefined(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve owner display settings for prompt rendering.
 * Keep auth secrets decoupled from owner hash secrets.
 */
export function resolveOwnerDisplaySetting(config?: OpenClawConfig): OwnerDisplaySetting {
  const ownerDisplay = config?.commands?.ownerDisplay;
  if (ownerDisplay !== "hash") {
    return { ownerDisplay, ownerDisplaySecret: undefined };
  }
  return {
    ownerDisplay: "hash",
    ownerDisplaySecret: trimToUndefined(config?.commands?.ownerDisplaySecret),
  };
}

/**
 * Ensure hash mode has a dedicated secret.
 * Returns updated config and generated secret when autofill was needed.
 */
export function ensureOwnerDisplaySecret(
  config: OpenClawConfig,
  generateSecret: () => string = () => crypto.randomBytes(32).toString("hex"),
): OwnerDisplaySecretResolution {
  const settings = resolveOwnerDisplaySetting(config);
  if (settings.ownerDisplay !== "hash" || settings.ownerDisplaySecret) {
    return { config };
  }
  const generatedSecret = generateSecret();
  return {
    config: {
      ...config,
      commands: {
        ...config.commands,
        ownerDisplay: "hash",
        ownerDisplaySecret: generatedSecret,
      },
    },
    generatedSecret,
  };
}
