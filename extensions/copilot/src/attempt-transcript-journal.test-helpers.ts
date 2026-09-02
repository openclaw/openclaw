import fs from "node:fs/promises";
import path from "node:path";
import type { SessionEvent } from "@github/copilot-sdk";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import type {
  TranscriptEntryAnchor,
  SessionTranscriptTargetParams,
  TranscriptTurnAdmission,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { vi, type Mock } from "vitest";
import { createAttemptTranscriptJournal } from "./attempt-transcript-journal.js";
import type { AttemptParamsLike } from "./attempt-types.js";
import { attachEventBridge, type SessionLike } from "./event-bridge.js";

const tempDirs: string[] = [];
const hostClosers: Array<() => void> = [];

export type FakeSession = SessionLike & {
  emit: (event: SessionEvent) => void;
};

type TranscriptRecorder = NonNullable<AttemptParamsLike["userTurnTranscriptRecorder"]> & {
  markBlocked: Mock<NonNullable<AttemptParamsLike["userTurnTranscriptRecorder"]>["markBlocked"]>;
  markRuntimePersisted: Mock<
    NonNullable<AttemptParamsLike["userTurnTranscriptRecorder"]>["markRuntimePersisted"]
  >;
  resolveMessage: Mock<
    NonNullable<AttemptParamsLike["userTurnTranscriptRecorder"]>["resolveMessage"]
  >;
};

type ExactTranscriptTarget = SessionTranscriptTargetParams &
  Required<
    Pick<SessionTranscriptTargetParams, "agentId" | "sessionId" | "sessionKey" | "storePath">
  >;

type AttemptTranscriptJournalFixture = {
  attempt: AttemptParamsLike;
  bridge: ReturnType<typeof attachEventBridge>;
  closeHost: () => void;
  journal: ReturnType<typeof createAttemptTranscriptJournal>;
  recorder: TranscriptRecorder;
  session: FakeSession;
  target: ExactTranscriptTarget;
  tempDir: string;
};

export function createFakeSession(): FakeSession {
  const listeners = new Map<string, Array<(event: SessionEvent) => void>>();
  return {
    abort: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    emit(sessionEvent) {
      for (const listener of listeners.get(sessionEvent.type) ?? []) {
        listener(sessionEvent);
      }
    },
    on: vi.fn((eventType: string, handler: (event: SessionEvent) => void) => {
      listeners.set(eventType, [...(listeners.get(eventType) ?? []), handler]);
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

export async function createFixture(
  trigger?: string,
  resultContentSourceByToolName?: ReadonlyMap<string, "network">,
  providerToolResultsOwned = false,
): Promise<AttemptTranscriptJournalFixture> {
  const tempDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-copilot-journal-"),
  );
  tempDirs.push(tempDir);
  const target: ExactTranscriptTarget = {
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
    markRuntimePersisted: vi.fn(
      (
        _message?: Extract<AgentMessage, { role: "user" }>,
        anchor?: TranscriptEntryAnchor | TranscriptTurnAdmission,
      ) => {
        persisted = true;
        admissionReceipt =
          anchor && "logicalTurnId" in anchor
            ? anchor
            : anchor
              ? { ...anchor, logicalTurnId: "logical-turn-1", role: "user" }
              : undefined;
      },
    ),
    markBlocked: vi.fn(() => {
      blocked = true;
    }),
    hasPersisted: () => persisted,
    isBlocked: () => blocked,
    hasRuntimePersistencePending: () => false,
    getAdmissionReceipt: () => admissionReceipt,
    waitForRuntimePersistence: vi.fn(async () => undefined),
    persistApproved: vi.fn(async () => undefined),
    persistBlocked: vi.fn(async () => undefined),
    persistFallback: vi.fn(async () => undefined),
  } satisfies TranscriptRecorder;
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
  const host = await createAgentHarnessHostCapabilitiesForTest({
    attempt,
    pluginId: "copilot",
    transcriptAuthority: {
      scope: target,
      lifecycleRevision: "revision-1",
      writerRunId: "run-1",
    },
  });
  let hostActive = true;
  const closeHost = () => {
    if (!hostActive) {
      return;
    }
    hostActive = false;
    host.close();
  };
  hostClosers.push(closeHost);
  attempt.hostCapabilities = host.capabilities;
  const session = createFakeSession();
  const journal = createAttemptTranscriptJournal({
    abortSession: () => session.abort(),
    attempt,
    messages: [],
    sdkSessionId: "sdk-session",
  });
  const bridge = attachEventBridge(session, {
    getSdkSessionId: () => "sdk-session",
    isAborted: () => false,
    transcriptProjection: {
      journal,
      modelRef: { api: "openai-responses", id: "gpt-5", provider: "github-copilot" },
      now: () => 2,
      providerToolResultsOwned,
      ...(resultContentSourceByToolName ? { resultContentSourceByToolName } : {}),
    },
  });
  return { attempt, bridge, closeHost, journal, recorder, session, target, tempDir };
}

export function transcriptMessages(events: unknown[]) {
  return events.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") {
      return [];
    }
    const record = entry as {
      id: string;
      parentId: string | null;
      message: AgentMessage & { display?: boolean; idempotencyKey?: string };
    };
    return [record];
  });
}

export async function cleanupAttemptTranscriptJournalFixtures(): Promise<void> {
  hostClosers.splice(0).forEach((close) => close());
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
}
