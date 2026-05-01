import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function proposalFromArgs(args) {
  const record = asRecord(args);
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!title) {
    throw new Error("openclaw_proposal requires a non-empty title.");
  }
  const actions = Array.isArray(record.actions)
    ? record.actions
        .filter((entry) => typeof entry === "string" && entry.trim())
        .map((entry) => entry.trim())
    : undefined;
  return {
    title,
    ...(typeof record.summary === "string" && record.summary.trim()
      ? { summary: record.summary.trim() }
      : {}),
    ...(typeof record.body === "string" && record.body.trim() ? { body: record.body.trim() } : {}),
    ...(actions && actions.length > 0 ? { actions } : {}),
    ...(typeof record.sessionKey === "string" && record.sessionKey.trim()
      ? { sessionKey: record.sessionKey.trim() }
      : {}),
    ...(typeof record.routeId === "string" && record.routeId.trim()
      ? { routeId: record.routeId.trim() }
      : {}),
    ...(typeof record.routeLabel === "string" && record.routeLabel.trim()
      ? { routeLabel: record.routeLabel.trim() }
      : {}),
  };
}

export async function createProposalInState(settings, proposal) {
  if (!settings.stateDir) {
    throw new Error("OPENCLAW_CODEX_BACKCHANNEL_STATE_DIR or OPENCLAW_STATE_DIR is required.");
  }
  const now = new Date().toISOString();
  const record = {
    id: randomUUID(),
    at: now,
    sessionKey: proposal.sessionKey || "codex:backchannel",
    routeId: proposal.routeId || "backchannel",
    routeLabel: proposal.routeLabel || "codex/backchannel",
    title: proposal.title,
    ...(proposal.summary ? { summary: proposal.summary } : {}),
    ...(proposal.body ? { body: proposal.body } : {}),
    ...(proposal.actions ? { actions: proposal.actions } : {}),
    status: "new",
    sourceEventId: `mcp:${randomUUID()}`,
  };
  const rootDir = path.join(settings.stateDir, "codex-sdk");
  await mkdir(rootDir, { recursive: true });
  await appendFile(
    path.join(rootDir, "proposal-inbox.jsonl"),
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
  return record;
}

export async function readLocalStatus(settings) {
  if (!settings.stateDir) {
    throw new Error("OPENCLAW_CODEX_BACKCHANNEL_STATE_DIR or OPENCLAW_STATE_DIR is required.");
  }
  const rootDir = path.join(settings.stateDir, "codex-sdk");
  const sessions = await readJson(path.join(rootDir, "sessions.json"), {});
  const proposals = await readJsonl(path.join(rootDir, "proposal-inbox.jsonl"));
  return {
    backend: "codex-sdk",
    healthy: false,
    source: "state",
    sessions: Object.values(sessions)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, 10),
    inbox: proposals
      .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
      .slice(0, 10),
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function readJsonl(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return raw
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
