import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { fetchZulipUsers, type ZulipClient, type ZulipUser } from "./client.js";

export type ZulipUserResolution = {
  input: string;
  resolved: boolean;
  id?: string;
  email?: string;
  name?: string;
  note?: string;
};

function normalizeInput(raw: string | number): string {
  return String(raw).trim();
}

function normalizeLookupValue(raw: string | number): string {
  return normalizeInput(raw)
    .replace(/^(zulip|user|dm):/i, "")
    .trim()
    .toLowerCase();
}

function emailLocalPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at).toLowerCase() : email.toLowerCase();
}

function isNumericIdentity(value: string): boolean {
  return /^\d+$/.test(value);
}

function isEmailIdentity(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function matchUsers(users: ZulipUser[], input: string): ZulipUser[] {
  const normalized = normalizeLookupValue(input);
  if (!normalized || normalized === "*") {
    return [];
  }

  if (isNumericIdentity(normalized)) {
    return users.filter((user) => String(user.user_id) === normalized);
  }

  if (isEmailIdentity(normalized)) {
    return users.filter((user) => user.email.trim().toLowerCase() === normalized);
  }

  const withoutAt = normalized.startsWith("@") ? normalized.slice(1) : normalized;
  return users.filter((user) => {
    const email = user.email.trim().toLowerCase();
    const localPart = emailLocalPart(email);
    const fullName = user.full_name.trim().toLowerCase();
    return withoutAt === localPart || normalized === fullName || withoutAt === fullName;
  });
}

export async function resolveZulipUserInputs(params: {
  client: ZulipClient;
  inputs: Array<string | number>;
}): Promise<ZulipUserResolution[]> {
  const rawInputs = params.inputs.map((input) => normalizeInput(input)).filter(Boolean);
  if (rawInputs.length === 0) {
    return [];
  }

  const users = await fetchZulipUsers(params.client);
  return rawInputs.map((input) => {
    const normalized = normalizeLookupValue(input);
    if (!normalized || normalized === "*") {
      return { input, resolved: false, note: "wildcard-or-empty" };
    }
    if (isNumericIdentity(normalized)) {
      const user = users.find((candidate) => String(candidate.user_id) === normalized);
      return {
        input,
        resolved: true,
        id: normalized,
        email: user?.email?.trim().toLowerCase() || undefined,
        name: user?.full_name?.trim() || undefined,
      };
    }
    const matches = matchUsers(users, normalized);
    if (matches.length !== 1) {
      return {
        input,
        resolved: false,
        note: matches.length > 1 ? "ambiguous" : "not-found",
      };
    }
    const user = matches[0];
    return {
      input,
      resolved: true,
      id: String(user.user_id),
      email: user.email.trim().toLowerCase(),
      name: user.full_name.trim() || undefined,
    };
  });
}

export function buildCanonicalZulipAllowList(params: {
  entries?: Array<string | number>;
  resolutions: ZulipUserResolution[];
}): string[] {
  const resolutionMap = new Map(
    params.resolutions.map((entry) => [normalizeInput(entry.input), entry]),
  );
  const seen = new Set<string>();
  const canonical: string[] = [];

  const add = (value?: string) => {
    const normalized = normalizeLookupValue(value ?? "");
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    canonical.push(normalized);
  };

  for (const entry of params.entries ?? []) {
    const input = normalizeInput(entry);
    if (!input) {
      continue;
    }
    if (input.trim() === "*") {
      add("*");
      continue;
    }
    const resolved = resolutionMap.get(input);
    if (resolved?.resolved) {
      add(resolved.id);
      add(resolved.email);
      continue;
    }
    add(input);
  }

  return canonical;
}

export function logZulipResolutionSummary(params: {
  label: string;
  resolutions: ZulipUserResolution[];
  runtime?: RuntimeEnv;
}) {
  const resolved = params.resolutions
    .filter((entry) => entry.resolved && entry.id)
    .map((entry) => `${entry.input}→${entry.id}`);
  const unresolved = params.resolutions
    .filter((entry) => !entry.resolved)
    .map((entry) => `${entry.input}${entry.note ? ` (${entry.note})` : ""}`);
  if (resolved.length > 0) {
    params.runtime?.log?.(
      `${params.label} resolved: ${resolved.slice(0, 6).join(", ")}${resolved.length > 6 ? " …" : ""}`,
    );
  }
  if (unresolved.length > 0) {
    params.runtime?.log?.(
      `${params.label} unresolved: ${unresolved.slice(0, 6).join(", ")}${unresolved.length > 6 ? " …" : ""}`,
    );
  }
}
