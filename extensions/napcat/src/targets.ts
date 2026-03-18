import { missingTargetError } from "openclaw/plugin-sdk";

export type ParsedNapCatTarget = {
  kind: "user" | "group";
  id: string;
  to: string;
};

export function normalizeNapCatAllowEntry(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "*") {
    return trimmed;
  }
  return trimmed
    .replace(/^(napcat|qq|onebot):/i, "")
    .replace(/^(user|private|group):/i, "")
    .trim();
}

function toTarget(kind: "user" | "group", id: string): ParsedNapCatTarget {
  return { kind, id, to: `${kind}:${id}` };
}

export function parseNapCatTarget(raw: string): ParsedNapCatTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed
    .replace(/^(napcat|qq|onebot):/i, "")
    .replace(/^chat:/i, "")
    .trim();

  const groupMatch = normalized.match(/^(group|g):\s*(\d+)$/i);
  if (groupMatch?.[2]) {
    return toTarget("group", groupMatch[2]);
  }

  const userMatch = normalized.match(/^(user|u|private|p):\s*(\d+)$/i);
  if (userMatch?.[2]) {
    return toTarget("user", userMatch[2]);
  }

  if (/^\d+$/.test(normalized)) {
    return toTarget("user", normalized);
  }

  return null;
}

export function isNapCatSenderAllowed(allowFrom: string[], senderId: string): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSender = normalizeNapCatAllowEntry(senderId);
  return allowFrom.some((entry) => normalizeNapCatAllowEntry(entry) === normalizedSender);
}

export function resolveNapCatTarget(params: {
  to?: string;
  mode?: "explicit" | "implicit" | "heartbeat";
  allowFrom?: string[];
}): { ok: true; to: string } | { ok: false; error: Error } {
  const explicit = params.to?.trim() ?? "";
  const mode = params.mode ?? "explicit";
  const allowFrom = params.allowFrom ?? [];

  if (explicit) {
    const parsed = parseNapCatTarget(explicit);
    if (!parsed) {
      return {
        ok: false,
        error: missingTargetError("NapCat", "<user:qq|group:qq>"),
      };
    }
    return { ok: true, to: parsed.to };
  }

  const candidateAllow = allowFrom
    .map((entry) => normalizeNapCatAllowEntry(entry))
    .filter((entry) => Boolean(entry) && entry !== "*");

  if (mode !== "explicit" && candidateAllow.length === 1) {
    const parsed = parseNapCatTarget(candidateAllow[0]);
    if (!parsed) {
      return {
        ok: false,
        error: missingTargetError("NapCat", "<user:qq|group:qq>"),
      };
    }
    return { ok: true, to: parsed.to };
  }

  return {
    ok: false,
    error: missingTargetError("NapCat", "<user:qq|group:qq>"),
  };
}
