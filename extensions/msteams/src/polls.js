import crypto from "node:crypto";
import { resolveMSTeamsStorePath } from "./storage.js";
import { readJsonFile, withFileLock, writeJsonFile } from "./store-fs.js";
const STORE_FILENAME = "msteams-polls.json";
const MAX_POLLS = 1e3;
const POLL_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function normalizeChoiceValue(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}
function extractSelections(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeChoiceValue).filter((entry) => Boolean(entry));
  }
  const normalized = normalizeChoiceValue(value);
  if (!normalized) {
    return [];
  }
  if (normalized.includes(",")) {
    return normalized.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return [normalized];
}
function readNestedValue(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return void 0;
    }
    current = current[key];
  }
  return current;
}
function readNestedString(value, keys) {
  const found = readNestedValue(value, keys);
  return typeof found === "string" && found.trim() ? found.trim() : void 0;
}
function extractMSTeamsPollVote(activity) {
  const value = activity?.value;
  if (!value || !isRecord(value)) {
    return null;
  }
  const pollId = readNestedString(value, ["openclawPollId"]) ?? readNestedString(value, ["pollId"]) ?? readNestedString(value, ["openclaw", "pollId"]) ?? readNestedString(value, ["openclaw", "poll", "id"]) ?? readNestedString(value, ["data", "openclawPollId"]) ?? readNestedString(value, ["data", "pollId"]) ?? readNestedString(value, ["data", "openclaw", "pollId"]);
  if (!pollId) {
    return null;
  }
  const directSelections = extractSelections(value.choices);
  const nestedSelections = extractSelections(readNestedValue(value, ["choices"]));
  const dataSelections = extractSelections(readNestedValue(value, ["data", "choices"]));
  const selections = directSelections.length > 0 ? directSelections : nestedSelections.length > 0 ? nestedSelections : dataSelections;
  if (selections.length === 0) {
    return null;
  }
  return {
    pollId,
    selections
  };
}
function buildMSTeamsPollCard(params) {
  const pollId = params.pollId ?? crypto.randomUUID();
  const maxSelections = typeof params.maxSelections === "number" && params.maxSelections > 1 ? Math.floor(params.maxSelections) : 1;
  const cappedMaxSelections = Math.min(Math.max(1, maxSelections), params.options.length);
  const choices = params.options.map((option, index) => ({
    title: option,
    value: String(index)
  }));
  const hint = cappedMaxSelections > 1 ? `Select up to ${cappedMaxSelections} option${cappedMaxSelections === 1 ? "" : "s"}.` : "Select one option.";
  const card = {
    type: "AdaptiveCard",
    version: "1.5",
    body: [
      {
        type: "TextBlock",
        text: params.question,
        wrap: true,
        weight: "Bolder",
        size: "Medium"
      },
      {
        type: "Input.ChoiceSet",
        id: "choices",
        isMultiSelect: cappedMaxSelections > 1,
        style: "expanded",
        choices
      },
      {
        type: "TextBlock",
        text: hint,
        wrap: true,
        isSubtle: true,
        spacing: "Small"
      }
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Vote",
        data: {
          openclawPollId: pollId,
          pollId
        },
        msteams: {
          type: "messageBack",
          text: "openclaw poll vote",
          displayText: "Vote recorded",
          value: { openclawPollId: pollId, pollId }
        }
      }
    ]
  };
  const fallbackLines = [
    `Poll: ${params.question}`,
    ...params.options.map((option, index) => `${index + 1}. ${option}`)
  ];
  return {
    pollId,
    question: params.question,
    options: params.options,
    maxSelections: cappedMaxSelections,
    card,
    fallbackText: fallbackLines.join("\n")
  };
}
function parseTimestamp(value) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function pruneExpired(polls) {
  const cutoff = Date.now() - POLL_TTL_MS;
  const entries = Object.entries(polls).filter(([, poll]) => {
    const ts = parseTimestamp(poll.updatedAt ?? poll.createdAt) ?? 0;
    return ts >= cutoff;
  });
  return Object.fromEntries(entries);
}
function pruneToLimit(polls) {
  const entries = Object.entries(polls);
  if (entries.length <= MAX_POLLS) {
    return polls;
  }
  entries.sort((a, b) => {
    const aTs = parseTimestamp(a[1].updatedAt ?? a[1].createdAt) ?? 0;
    const bTs = parseTimestamp(b[1].updatedAt ?? b[1].createdAt) ?? 0;
    return aTs - bTs;
  });
  const keep = entries.slice(entries.length - MAX_POLLS);
  return Object.fromEntries(keep);
}
function normalizeMSTeamsPollSelections(poll, selections) {
  const maxSelections = Math.max(1, poll.maxSelections);
  const mapped = selections.map((entry) => Number.parseInt(entry, 10)).filter((value) => Number.isFinite(value)).filter((value) => value >= 0 && value < poll.options.length).map((value) => String(value));
  const limited = maxSelections > 1 ? mapped.slice(0, maxSelections) : mapped.slice(0, 1);
  return Array.from(new Set(limited));
}
function createMSTeamsPollStoreFs(params) {
  const filePath = resolveMSTeamsStorePath({
    filename: STORE_FILENAME,
    env: params?.env,
    homedir: params?.homedir,
    stateDir: params?.stateDir,
    storePath: params?.storePath
  });
  const empty = { version: 1, polls: {} };
  const readStore = async () => {
    const { value } = await readJsonFile(filePath, empty);
    const pruned = pruneToLimit(pruneExpired(value.polls ?? {}));
    return { version: 1, polls: pruned };
  };
  const writeStore = async (data) => {
    await writeJsonFile(filePath, data);
  };
  const createPoll = async (poll) => {
    await withFileLock(filePath, empty, async () => {
      const data = await readStore();
      data.polls[poll.id] = poll;
      await writeStore({ version: 1, polls: pruneToLimit(data.polls) });
    });
  };
  const getPoll = async (pollId) => await withFileLock(filePath, empty, async () => {
    const data = await readStore();
    return data.polls[pollId] ?? null;
  });
  const recordVote = async (params2) => await withFileLock(filePath, empty, async () => {
    const data = await readStore();
    const poll = data.polls[params2.pollId];
    if (!poll) {
      return null;
    }
    const normalized = normalizeMSTeamsPollSelections(poll, params2.selections);
    poll.votes[params2.voterId] = normalized;
    poll.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    data.polls[poll.id] = poll;
    await writeStore({ version: 1, polls: pruneToLimit(data.polls) });
    return poll;
  });
  return { createPoll, getPoll, recordVote };
}
export {
  buildMSTeamsPollCard,
  createMSTeamsPollStoreFs,
  extractMSTeamsPollVote,
  normalizeMSTeamsPollSelections
};
