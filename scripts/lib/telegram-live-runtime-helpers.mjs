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

function stripOuterQuotes(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseEnvAssignmentLine(line, key) {
  const match = String(line ?? "").match(
    new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=[\\t ]*(.*)$`),
  );
  if (!match) {
    return null;
  }

  return stripOuterQuotes(match[1].trim());
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

export function clearEnvAssignmentText(params) {
  const key = String(params?.key ?? "").trim();
  const content = String(params?.content ?? "");

  if (!key) {
    return {
      content,
      removed: false,
      removedValue: "",
    };
  }

  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/g);
  if (hadTrailingNewline && lines.at(-1) === "") {
    lines.pop();
  }
  const keptLines = [];
  let removedValue = "";

  // Drop every assignment for the key so releasing a worktree claim never
  // exposes an older value that was shadowed later in the file.
  for (const line of lines) {
    const parsed = parseEnvAssignmentLine(line, key);
    if (parsed === null) {
      keptLines.push(line);
      continue;
    }
    removedValue = parsed;
  }

  let nextContent = keptLines.join(newline);
  if (hadTrailingNewline && nextContent.length > 0) {
    nextContent += newline;
  }

  return {
    content: nextContent,
    removed: removedValue.length > 0,
    removedValue,
  };
}

function normalizeNumericId(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchesTelegramSessionTarget(entry, chatId, threadId, agentId) {
  if (!entry || typeof entry !== "object") {
    return false;
  }

  const candidateAgentId =
    typeof entry.agentId === "string" && entry.agentId.trim()
      ? entry.agentId.trim()
      : typeof entry.origin?.agentId === "string" && entry.origin.agentId.trim()
        ? entry.origin.agentId.trim()
        : null;
  if (agentId && candidateAgentId && candidateAgentId !== agentId) {
    return false;
  }

  const channel = entry.channel ?? entry.deliveryContext?.channel ?? entry.origin?.provider;
  if (channel !== "telegram") {
    return false;
  }

  const candidateThreadIds = [
    entry.deliveryContext?.threadId,
    entry.lastThreadId,
    entry.origin?.threadId,
  ]
    .map(normalizeNumericId)
    .filter((value) => value !== null);
  if (!candidateThreadIds.includes(threadId)) {
    return false;
  }

  const candidateTargets = [
    entry.groupId,
    entry.lastTo,
    entry.origin?.from,
    entry.origin?.to,
    entry.deliveryContext?.to,
  ]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim());

  if (chatId.startsWith("-")) {
    return candidateTargets.some((value) => value.includes(chatId));
  }

  return candidateTargets.some(
    (value) => value === `telegram:${chatId}` || value.endsWith(`:${chatId}`),
  );
}

export function pruneTelegramThreadSessions(params) {
  const sessions =
    params?.sessions && typeof params.sessions === "object" && !Array.isArray(params.sessions)
      ? { ...params.sessions }
      : {};
  const chatId = String(params?.chatId ?? "").trim();
  const threadId = normalizeNumericId(params?.threadId);
  const agentId = String(params?.agentId ?? "main").trim() || "main";

  if (!chatId || threadId === null) {
    return {
      sessions,
      removedKeys: [],
    };
  }

  const removedKeys = [];
  for (const [key, entry] of Object.entries(sessions)) {
    if (!key.startsWith(`agent:${agentId}:`)) {
      continue;
    }
    if (!matchesTelegramSessionTarget(entry, chatId, threadId, agentId)) {
      continue;
    }
    removedKeys.push(key);
    delete sessions[key];
  }

  return {
    sessions,
    removedKeys,
  };
}
