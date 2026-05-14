import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InboundTurnContext } from "../../auto-reply/reply/inbound-meta.js";
import { resolveStateDir } from "../../config/paths.js";

/**
 * Environment variable that points a CLI agent subprocess at the on-disk file
 * holding the *current* inbound turn's identifiers.
 *
 * The value is a stable, session-scoped path. CLI backends that keep a
 * long-lived "live session" process across turns only see spawn-time
 * environment once, so the identifiers themselves cannot ride on env vars —
 * they would go stale after the first turn. Instead the path is stable and the
 * file behind it is rewritten every turn (see `writeInboundTurnFile`), so a
 * shell wrapper run by the agent always reads the live turn's values.
 */
export const INBOUND_TURN_FILE_ENV_KEY = "OPENCLAW_INBOUND_TURN_FILE";

const INBOUND_TURN_FILE_SCHEMA = "openclaw.inbound_turn.v1";
const INBOUND_TURN_DIR_MODE = 0o700;
const INBOUND_TURN_FILE_MODE = 0o600;

function sanitizeSessionIdForPath(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "default";
}

/**
 * Stable, session-scoped path for the current turn's inbound identifiers.
 * Keyed by session id so the path survives across turns of the same session
 * (the env var is set once at spawn) while the contents are rewritten per turn.
 */
export function resolveInboundTurnFilePath(params: {
  sessionId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const stateDir = resolveStateDir(params.env ?? process.env);
  return path.join(
    stateDir,
    "tmp",
    "inbound-turn",
    `${sanitizeSessionIdForPath(params.sessionId)}.json`,
  );
}

export type InboundTurnFilePayload = InboundTurnContext & {
  schema: typeof INBOUND_TURN_FILE_SCHEMA;
  runId?: string;
  writtenAt: number;
};

/** Rewrite the per-turn inbound file with the current turn's identifiers. */
export function writeInboundTurnFile(
  filePath: string,
  turn: InboundTurnContext,
  meta?: { runId?: string },
): void {
  const payload: InboundTurnFilePayload = {
    schema: INBOUND_TURN_FILE_SCHEMA,
    ...turn,
    ...(meta?.runId ? { runId: meta.runId } : {}),
    writtenAt: Date.now(),
  };
  mkdirSync(path.dirname(filePath), { recursive: true, mode: INBOUND_TURN_DIR_MODE });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: INBOUND_TURN_FILE_MODE,
  });
}
