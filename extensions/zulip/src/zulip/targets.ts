import { normalizeStreamName, normalizeTopic } from "./normalize.js";

export type ZulipStreamTarget = {
  kind: "stream";
  stream: string;
  topic?: string;
};

export function parseZulipTarget(raw: string): ZulipStreamTarget | null {
  let trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  trimmed = trimmed.replace(/^zulip:/i, "").trim();
  if (!/^stream:/i.test(trimmed)) {
    return null;
  }
  trimmed = trimmed.replace(/^stream:/i, "").trim();
  if (!trimmed) {
    return null;
  }
  const hashIdx = trimmed.indexOf("#");
  if (hashIdx < 0) {
    return { kind: "stream", stream: normalizeStreamName(trimmed) };
  }
  const streamRaw = trimmed.slice(0, hashIdx);
  const topicRaw = trimmed.slice(hashIdx + 1);
  const stream = normalizeStreamName(streamRaw);
  if (!stream) {
    return null;
  }
  const topic = normalizeTopic(topicRaw);
  return topic ? { kind: "stream", stream, topic } : { kind: "stream", stream };
}

export function formatZulipStreamTarget(target: { stream: string; topic?: string }): string {
  const stream = normalizeStreamName(target.stream);
  const topic = normalizeTopic(target.topic ?? "");
  if (topic) {
    return `stream:${stream}#${topic}`;
  }
  return `stream:${stream}`;
}
