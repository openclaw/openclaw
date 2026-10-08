import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asOptionalRecord,
  readNonEmptyStringPreservingWhitespace,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const UPSTREAM_USER_TEXT_META_KEY = "upstreamUserText" as const;
const MIRROR_IDENTITY_META_KEY = "mirrorIdentity" as const;
const CODEX_META_KEY = "__openclaw";
function readCodexMeta(message: AgentMessage | undefined) {
  return message && CODEX_META_KEY in message
    ? asOptionalRecord(message[CODEX_META_KEY])
    : undefined;
}

function attachCodexMeta<T extends AgentMessage>(message: T, key: string, value: string): T {
  return {
    ...message,
    __openclaw: { ...readCodexMeta(message), [key]: value },
  };
}

export function attachCodexMirrorIdentity<T extends AgentMessage>(message: T, identity: string): T {
  return attachCodexMeta(message, MIRROR_IDENTITY_META_KEY, identity);
}

export function readMirrorIdentity(message: AgentMessage): string | undefined {
  return readNonEmptyStringPreservingWhitespace(readCodexMeta(message)?.[MIRROR_IDENTITY_META_KEY]);
}

export function attachUpstreamUserText<T extends AgentMessage>(message: T, text: string): T {
  return attachCodexMeta(message, UPSTREAM_USER_TEXT_META_KEY, text);
}

export function readUpstreamUserText(message: AgentMessage | undefined): string | undefined {
  return readNonEmptyStringPreservingWhitespace(
    readCodexMeta(message)?.[UPSTREAM_USER_TEXT_META_KEY],
  );
}
