import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asOptionalRecord,
  readNonEmptyStringPreservingWhitespace,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const UPSTREAM_USER_TEXT_META_KEY = "upstreamUserText" as const;
const MIRROR_IDENTITY_META_KEY = "mirrorIdentity" as const;
const CODEX_META_KEY = "__openclaw";

export function attachCodexMirrorIdentity<T extends AgentMessage>(message: T, identity: string): T {
  const existing = CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  const baseMeta = asOptionalRecord(existing) ?? {};
  return {
    ...message,
    __openclaw: { ...baseMeta, [MIRROR_IDENTITY_META_KEY]: identity },
  };
}

export function readMirrorIdentity(message: AgentMessage): string | undefined {
  const meta = CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  return readNonEmptyStringPreservingWhitespace(asOptionalRecord(meta)?.[MIRROR_IDENTITY_META_KEY]);
}

export function attachUpstreamUserText<T extends AgentMessage>(message: T, text: string): T {
  const existing = CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  const baseMeta = asOptionalRecord(existing) ?? {};
  return {
    ...message,
    __openclaw: { ...baseMeta, [UPSTREAM_USER_TEXT_META_KEY]: text },
  };
}

export function readUpstreamUserText(message: AgentMessage | undefined): string | undefined {
  const meta = message && CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  return readNonEmptyStringPreservingWhitespace(
    asOptionalRecord(meta)?.[UPSTREAM_USER_TEXT_META_KEY],
  );
}
