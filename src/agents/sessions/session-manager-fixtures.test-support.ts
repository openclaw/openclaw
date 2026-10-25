import assert from "node:assert/strict";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as contextWorker from "../../config/sessions/session-transcript-read-worker-runtime.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import type { SessionManager } from "./session-manager.js";

export function assistantText(text: string) {
  return makeAgentAssistantMessage({ content: [{ type: "text", text }] });
}

export async function expectCancelledReads(read: (signal: AbortSignal) => Promise<unknown>) {
  for (const alreadyAborted of [true, false]) {
    const controller = new AbortController();
    const reason = new Error("context cancelled");
    if (alreadyAborted) {
      controller.abort(reason);
    }
    const pending = read(controller.signal);
    if (!alreadyAborted) {
      controller.abort(reason);
    }
    await expect(pending).rejects.toBe(reason);
  }
}

export function customData(manager: SessionManager, id: string) {
  const entry = manager.getEntry(id);
  assert(entry?.type === "custom" && isRecord(entry.data), "Missing custom payload");
  return entry.data;
}

export function opaqueEntry(manager: SessionManager) {
  const entry = manager
    .getPersistedEntries()
    .find((value) => isRecord(value) && value.type === "opaque");
  assert(isRecord(entry), "Missing opaque record");
  return entry;
}

export function afterModelRead(after: () => void | Promise<void>, restoreBeforeRead = false) {
  const read = contextWorker.readSessionTranscriptModelContextInWorker;
  const spy = vi
    .spyOn(contextWorker, "readSessionTranscriptModelContextInWorker")
    .mockImplementationOnce(async (...args) => {
      if (restoreBeforeRead) {
        spy.mockRestore();
      }
      const context = await read(...args);
      const pending = after();
      if (pending) {
        await pending;
      }
      return context;
    });
  return spy;
}

export function sessionScope(storePath: string, sessionId: string) {
  return { agentId: "main", sessionId, sessionKey: `agent:main:${sessionId}`, storePath };
}

export function withSessionState<T>(
  sessionId: string,
  run: (fixture: {
    state: OpenClawTestState;
    scope: ReturnType<typeof sessionScope>;
  }) => Promise<T>,
  options: {
    storePath?: (state: OpenClawTestState) => string;
  } = {},
) {
  return withOpenClawTestState({ label: sessionId }, async (state) => {
    const scope = sessionScope(
      options.storePath?.(state) ?? path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      sessionId,
    );
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    return run({ state, scope });
  });
}

export function withTranscriptState<T>(
  sessionId: string,
  run: Parameters<typeof withSessionState<T>>[1],
) {
  return withSessionState(sessionId, run, {
    storePath: (state) => state.statePath("transcript.sqlite"),
  });
}
