import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const DEFAULT_PORT_BASE = 20000;
const DEFAULT_PORT_RANGE = 10000;

function normalizeTokenList(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function deriveTelegramLiveRuntimeProfile(params) {
  const worktreePath = path.resolve(String(params?.worktreePath ?? ""));
  const stateRoot =
    params?.stateRoot && String(params.stateRoot).trim().length > 0
      ? path.resolve(String(params.stateRoot))
      : path.join(os.homedir(), ".openclaw", "telegram-live-worktrees");
  const portBase = Number.isFinite(params?.portBase) ? Number(params.portBase) : DEFAULT_PORT_BASE;
  const portRange =
    Number.isFinite(params?.portRange) && Number(params.portRange) > 0
      ? Number(params.portRange)
      : DEFAULT_PORT_RANGE;

  const hash = crypto.createHash("sha256").update(worktreePath).digest("hex");
  const profileId = `tg-live-${hash.slice(0, 10)}`;
  const hashInt = Number.parseInt(hash.slice(0, 8), 16);
  const runtimePort = portBase + (Number.isFinite(hashInt) ? hashInt % portRange : 0);
  const runtimeStateDir = path.join(stateRoot, profileId);

  return {
    worktreePath,
    profileId,
    runtimePort,
    runtimeStateDir,
  };
}

export function selectTelegramTesterToken(params) {
  const poolTokens = normalizeTokenList(params?.poolTokens ?? []);
  const claimedTokens = new Set(normalizeTokenList(params?.claimedTokens ?? []));
  const currentToken = String(params?.currentToken ?? "").trim();

  if (poolTokens.length === 0) {
    return {
      ok: false,
      action: "fail",
      reason: "empty_pool",
      selectedToken: null,
    };
  }

  if (currentToken && poolTokens.includes(currentToken) && !claimedTokens.has(currentToken)) {
    return {
      ok: true,
      action: "retain",
      reason: "current_available",
      selectedToken: currentToken,
    };
  }

  for (const candidate of poolTokens) {
    if (!claimedTokens.has(candidate)) {
      return {
        ok: true,
        action: "assign",
        reason: currentToken ? "reassign_conflict_or_invalid" : "first_claim",
        selectedToken: candidate,
      };
    }
  }

  return {
    ok: false,
    action: "fail",
    reason: "pool_exhausted",
    selectedToken: null,
  };
}
