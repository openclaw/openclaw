import JSON5 from "json5";
import crypto from "node:crypto";
import path from "node:path";
import type { ContactsFile, TierConfig, TierFile, ValidationResult } from "./types.js";
import { CONFIRM_TTL_MS, FALLBACK_EXTERNAL_CEILING, FALLBACK_OWNER_CEILING } from "./constants.js";
import {
  isValidContactSlug,
  normalizeId,
  normalizePath,
  parseJsonSafe,
  parseYamlSafe,
  readFileIfExists,
  uniqueStrings,
} from "./normalize.js";
import { mergeTier, normalizeTierState, validateTierAgainstCeiling } from "./tiers.js";

const pendingConfigConfirmations = new Map<
  string,
  { token: string; payloadHash: string; expiresAtMs: number }
>();

export function cleanupPendingConfirmations(now: number): void {
  for (const [key, entry] of pendingConfigConfirmations) {
    if (entry.expiresAtMs < now) {
      pendingConfigConfirmations.delete(key);
    }
  }
}

export function payloadHash(payload: string): string {
  return crypto.createHash("sha256").update(payload, "utf-8").digest("hex");
}

function confirmationKey(params: {
  workspaceDir: string;
  sessionKey?: string;
  relPath: string;
}): string {
  return `${params.workspaceDir}::${params.sessionKey ?? "no-session"}::${normalizePath(params.relPath)}`;
}

function makeConfirmationToken(): string {
  return crypto.randomUUID().split("-")[0] ?? crypto.randomUUID();
}

export function requireWriteConfirmation(params: {
  workspaceDir: string;
  sessionKey?: string;
  relPath: string;
  contentHash: string;
  confirmToken?: string;
}): ValidationResult {
  const key = confirmationKey(params);
  const now = Date.now();
  const existing = pendingConfigConfirmations.get(key);
  if (existing && existing.expiresAtMs < now) {
    pendingConfigConfirmations.delete(key);
  }

  const token = params.confirmToken?.trim();
  const active = pendingConfigConfirmations.get(key);
  if (
    token &&
    active &&
    token === active.token &&
    active.payloadHash === params.contentHash &&
    active.expiresAtMs >= now
  ) {
    pendingConfigConfirmations.delete(key);
    return { ok: true, errors: [] };
  }

  const generated = makeConfirmationToken();
  pendingConfigConfirmations.set(key, {
    token: generated,
    payloadHash: params.contentHash,
    expiresAtMs: now + CONFIRM_TTL_MS,
  });

  return {
    ok: false,
    errors: [
      `Confirmation required for config write (${normalizePath(params.relPath)}). Re-run with confirmToken: ${generated}`,
    ],
  };
}

export function validateContactsPayload(params: {
  content: string;
  knownTierNames: Set<string>;
}): ValidationResult {
  const parsed = parseJsonSafe<ContactsFile>(params.content);
  if (!parsed || !Array.isArray(parsed.contacts)) {
    return { ok: false, errors: ["contacts.json must contain a contacts array"] };
  }

  const errors: string[] = [];
  const seenSlugs = new Set<string>();
  for (const [index, entry] of parsed.contacts.entries()) {
    if (!entry || typeof entry !== "object") {
      errors.push(`contacts[${index}] must be an object`);
      continue;
    }
    const slug = normalizeId(entry.slug);
    if (!slug) {
      errors.push(`contacts[${index}].slug is required`);
      continue;
    }
    if (!isValidContactSlug(slug)) {
      errors.push(`contacts[${index}].slug must match ^[a-z0-9][a-z0-9_-]{0,63}$ (${slug})`);
      continue;
    }
    if (seenSlugs.has(slug)) {
      errors.push(`contacts[${index}].slug must be unique (${slug})`);
    }
    seenSlugs.add(slug);

    const tier = normalizeId(entry.tier);
    if (tier && !params.knownTierNames.has(tier)) {
      errors.push(`contacts[${index}].tier references unknown tier (${tier})`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateOpenClawConfigPayload(content: string): ValidationResult {
  try {
    const parsed = JSON5.parse(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, errors: ["OpenClaw config must be an object"] };
    }
    const session = parsed.session;
    if (session && typeof session === "object") {
      const links = (session as { identityLinks?: unknown }).identityLinks;
      if (links && typeof links !== "object") {
        return { ok: false, errors: ["session.identityLinks must be an object map"] };
      }
    }
    return { ok: true, errors: [] };
  } catch (err) {
    return {
      ok: false,
      errors: [
        `OpenClaw config is invalid JSON5: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}

export function validateTiersPayload(content: string): ValidationResult {
  const parsed = parseYamlSafe<TierFile>(content);
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, errors: ["tiers.yaml is invalid YAML"] };
  }

  const owner = mergeTier(FALLBACK_OWNER_CEILING, parsed.fixed?.owner ?? {});
  const externalRaw = parsed.fixed?.external;
  const externalCeiling =
    externalRaw &&
    typeof externalRaw === "object" &&
    ("ceiling" in externalRaw || "effective" in externalRaw)
      ? mergeTier(FALLBACK_EXTERNAL_CEILING, externalRaw.ceiling ?? {})
      : mergeTier(FALLBACK_EXTERNAL_CEILING, (externalRaw as TierConfig | undefined) ?? {});
  const externalEffective =
    externalRaw &&
    typeof externalRaw === "object" &&
    ("ceiling" in externalRaw || "effective" in externalRaw)
      ? mergeTier(externalCeiling, externalRaw.effective ?? {})
      : mergeTier(
          externalCeiling,
          externalRaw && typeof externalRaw === "object" ? (externalRaw as TierConfig) : undefined,
        );

  const errors: string[] = [];
  errors.push(
    ...validateTierAgainstCeiling({
      tierName: "fixed.owner",
      tier: owner,
      ceiling: FALLBACK_OWNER_CEILING,
    }),
  );
  errors.push(
    ...validateTierAgainstCeiling({
      tierName: "fixed.external.ceiling",
      tier: externalCeiling,
      ceiling: FALLBACK_EXTERNAL_CEILING,
    }),
  );
  errors.push(
    ...validateTierAgainstCeiling({
      tierName: "fixed.external.effective",
      tier: externalEffective,
      ceiling: externalCeiling,
    }),
  );

  for (const [name, tier] of Object.entries(parsed.custom ?? {})) {
    const mergedCustom = mergeTier({ tools: [], skills: [], memory_scope: [] }, tier ?? {});
    errors.push(
      ...validateTierAgainstCeiling({
        tierName: `custom.${name}`,
        tier: mergedCustom,
        ceiling: owner,
      }),
    );
  }

  return { ok: errors.length === 0, errors };
}

function resolveKnownTierNamesFromTiersContent(content: string): Set<string> | null {
  const parsed = parseYamlSafe<TierFile>(content);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const state = normalizeTierState(parsed);
  return new Set<string>(["owner", "external", ...Object.keys(state.custom).map((entry) => normalizeId(entry))]);
}

export async function validateConfigWrite(params: {
  workspaceDir: string;
  relPath: string;
  content: string;
}): Promise<ValidationResult> {
  const normalized = normalizePath(params.relPath);
  if (normalized === "config/contacts.json") {
    const tiersPath = path.join(params.workspaceDir, "config", "tiers.yaml");
    const tiersRaw = await readFileIfExists(tiersPath);
    const knownTierNames = tiersRaw
      ? resolveKnownTierNamesFromTiersContent(tiersRaw)
      : new Set<string>([
          "owner",
          "external",
          ...Object.keys(normalizeTierState({}).custom).map((entry) => normalizeId(entry)),
        ]);
    if (!knownTierNames) {
      return {
        ok: false,
        errors: [
          "tiers.yaml is invalid YAML; fix config/tiers.yaml before updating config/contacts.json",
        ],
      };
    }
    return validateContactsPayload({ content: params.content, knownTierNames });
  }
  if (normalized === "config/tiers.yaml") {
    const tiersValidation = validateTiersPayload(params.content);
    if (!tiersValidation.ok) {
      return tiersValidation;
    }
    const knownTierNames = resolveKnownTierNamesFromTiersContent(params.content);
    if (!knownTierNames) {
      return {
        ok: false,
        errors: ["tiers.yaml is invalid YAML"],
      };
    }
    const contactsPath = path.join(params.workspaceDir, "config", "contacts.json");
    const contactsRaw = await readFileIfExists(contactsPath);
    if (!contactsRaw) {
      return tiersValidation;
    }
    const contactsValidation = validateContactsPayload({
      content: contactsRaw,
      knownTierNames,
    });
    if (!contactsValidation.ok) {
      return {
        ok: false,
        errors: contactsValidation.errors.map((entry) => `contacts.json compatibility check: ${entry}`),
      };
    }
    return tiersValidation;
  }
  if (
    normalized === "openclaw.json" ||
    normalized === "openclaw.json5" ||
    normalized.endsWith("/openclaw.json") ||
    normalized.endsWith("/openclaw.json5")
  ) {
    return validateOpenClawConfigPayload(params.content);
  }
  return { ok: true, errors: [] };
}
