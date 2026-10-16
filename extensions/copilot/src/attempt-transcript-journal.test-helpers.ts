import { EventEmitter } from "node:events";
import path from "node:path";
import type { SessionEvent } from "@github/copilot-sdk";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import type {
  SessionTranscriptTargetParams,
  TranscriptTurnAdmission,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, vi } from "vitest";
import { createAttemptTranscriptJournal } from "./attempt-transcript-journal.js";
import type { AttemptParamsLike } from "./attempt-types.js";
import { attachEventBridge, type SessionLike } from "./event-bridge.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-copilot-journal-");

export type FakeSession = SessionLike & {
  emit: (event: SessionEvent) => void;
};

type TranscriptRecorderContract = NonNullable<AttemptParamsLike["userTurnTranscriptRecorder"]>;

export function createFakeSession(): FakeSession {
  const events = new EventEmitter();
  return {
    abort: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    emit: (sessionEvent) => void events.emit(sessionEvent.type, sessionEvent),
    on: vi.fn((eventType: string, handler: (event: SessionEvent) => void) => {
      events.on(eventType, handler);
      return () => void events.off(eventType, handler);
    }) as FakeSession["on"],
    send: vi.fn(async () => "sdk-user"),
    sendAndWait: vi.fn(async () => undefined),
    sessionId: "sdk-session",
  };
}

export function event(
  type: string,
  id: string,
  data: Record<string, unknown>,
  agentId?: string,
): SessionEvent {
  return {
    type,
    id,
    parentId: null,
    timestamp: "2026-07-26T12:00:00.000Z",
    data,
    ...(agentId ? { agentId } : {}),
  } as SessionEvent;
}

export function createJournalSession(
  attempt: AttemptParamsLike,
  messages: AgentMessage[] = [],
  resultContentSourceByToolName?: ReadonlyMap<string, "network">,
) {
  const session = createFakeSession();
  const journal = createAttemptTranscriptJournal({
    abortSession: () => session.abort(),
    attempt,
    messages,
    sdkSessionId: "sdk-session",
  });
  const bridge = attachEventBridge(session, {
    getSdkSessionId: () => "sdk-session",
    isAborted: () => false,
    transcriptProjection: {
      journal,
      modelRef: { api: "openai-responses", id: "gpt-5", provider: "github-copilot" },
      now: () => 2,
      ...(resultContentSourceByToolName ? { resultContentSourceByToolName } : {}),
    },
  });
  return { bridge, journal, session };
}

export function emitReplayGroup(targetSession: FakeSession): void {
  targetSession.emit(event("user.message", "initial-user", { content: "inspect both files" }));
  targetSession.emit(
    event("assistant.message", "assistant-replay", {
      content: "checking",
      messageId: "assistant-replay",
      toolRequests: [{ arguments: {}, name: "read", toolCallId: "call-replay" }],
    }),
  );
  targetSession.emit(
    event("tool.execution_complete", "result-replay", {
      result: { content: "done" },
      success: true,
      toolCallId: "call-replay",
    }),
  );
}

export async function createFixture(
  trigger?: string,
  resultContentSourceByToolName?: ReadonlyMap<string, "network">,
) {
  const tempDir = sessionDirs.make();
  const target: SessionTranscriptTargetParams = {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    storePath: path.join(tempDir, "sessions.json"),
  };
  const userMessage: Extract<AgentMessage, { role: "user" }> = {
    role: "user",
    content: "inspect both files",
    timestamp: 1,
  };
  let blocked = false;
  let persisted = false;
  let admissionReceipt: TranscriptTurnAdmission | undefined;
  const recorder = {
    message: userMessage,
    resolveMessage: vi.fn(async () => userMessage),
    markRuntimePersistencePending: vi.fn(),
    markRuntimePersisted: vi.fn<TranscriptRecorderContract["markRuntimePersisted"]>(
      (_message, anchor) => {
        persisted = true;
        admissionReceipt =
          anchor && "logicalTurnId" in anchor
            ? anchor
            : anchor
              ? { ...anchor, logicalTurnId: "logical-turn-1", role: "user" }
              : undefined;
      },
    ),
    markBlocked: vi.fn(() => void (blocked = true)),
    hasPersisted: () => persisted,
    isBlocked: () => blocked,
    hasRuntimePersistencePending: () => false,
    getAdmissionReceipt: () => admissionReceipt,
    waitForRuntimePersistence: vi.fn(async () => undefined),
    persistApproved: vi.fn(async () => undefined),
    persistBlocked: vi.fn(async () => undefined),
    persistFallback: vi.fn(async () => undefined),
  } satisfies TranscriptRecorderContract;
  const attempt = {
    agentId: "main",
    prompt: "inspect both files",
    runId: "run-1",
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    sessionTarget: target,
    timeoutMs: 1000,
    trigger,
    userTurnTranscriptRecorder: recorder,
  } as unknown as AttemptParamsLike;
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: 1 },
  });
  const runtime = createJournalSession(attempt, [], resultContentSourceByToolName);
  return { attempt, ...runtime, recorder, target, tempDir };
}

export function transcriptMessages(events: unknown[]) {
  return events.filter(
    (
      entry,
    ): entry is {
      id: string;
      parentId: string | null;
      message: AgentMessage & { display?: boolean; idempotencyKey?: string };
    } => entry !== null && typeof entry === "object" && "type" in entry && entry.type === "message",
  );
}
