import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { buildOpenAIResponsesParams } from "../../../../packages/ai/src/transports/openai-responses-params-internal.js";
import { createSolidPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { Context } from "../../../llm/types.js";
import { finalizeRuntimePromptImages } from "../../../media/runtime-prompt-image-provenance.js";
import { annotateInterSessionPromptText } from "../../../sessions/input-provenance.js";
import {
  createUserTurnTranscriptRecorder,
  type UserTurnInput,
} from "../../../sessions/user-turn-transcript.js";
import { readTranscriptMessages } from "../../../sessions/user-turn-transcript.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { withSessionManagerWrite } from "../../sessions/session-manager-write-admission.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { serializeCacheTtlToolResultProjections } from "../cache-ttl-checkpoint.js";
import {
  clearEmbeddedSessionPromptStates,
  createToolResultPromptProjectionState,
  retainEmbeddedSessionPromptState,
  persistToolResultProjections,
} from "../session-prompt-state.js";
import { restoreCacheTtlToolResultProjections } from "../tool-result-truncation.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import {
  createBaseInput,
  sessionId as modelPromptSessionId,
} from "./attempt-prompt-submit.test-support.js";
import { createUserTranscriptContextRegistry } from "./attempt-user-transcript-context-registry.js";
import { hydratePromptMediaMessages } from "./images.js";
import { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";

registerAgentSessionLoopTestLifecycle();
const toolProjectionSessionId = "projection-dispatch";

afterEach(() => {
  clearEmbeddedSessionPromptStates([toolProjectionSessionId, modelPromptSessionId]);
});

function captureRequests() {
  const requests: ReturnType<typeof buildOpenAIResponsesParams>[] = [];
  streamMocks.streamSimple.mockImplementation((model, context) => {
    requests.push(buildOpenAIResponsesParams(model, context, undefined));
    return createAssistantResultStream(createAssistant(model, "done"));
  });
  return requests;
}

function normalizeSession(
  session: Awaited<ReturnType<typeof createTestSession>>["session"],
  options: () => Parameters<typeof normalizeMessagesForLlmBoundary>[1] = () => undefined,
) {
  const convert = session.agent.convertToLlm;
  session.agent.convertToLlm = (messages) =>
    convert(normalizeMessagesForLlmBoundary(messages, options()));
}

type Submission = Parameters<typeof submitEmbeddedAttemptPrompt>[0];
type TestSession = Awaited<ReturnType<typeof createTestSession>>["session"];
type Recorder = ReturnType<typeof createUserTurnTranscriptRecorder>;
type Contexts = ReturnType<typeof createUserTranscriptContextRegistry>;

async function projectionTarget(state: OpenClawTestState, name: string, redact = false) {
  const target = {
    agentId: "main",
    sessionId: modelPromptSessionId,
    sessionKey: `agent:main:${name}`,
    storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    ...(redact ? { config: { logging: { redactPatterns: ["hidden"] } } } : {}),
  };
  setRuntimeConfigSnapshot(target.config ?? {});
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  return target;
}

function guardRecorder(
  manager: SessionManager,
  recorder: Recorder | undefined,
  contexts: Contexts,
  suppressNextUserMessagePersistence?: boolean,
) {
  return guardSessionManager(manager, {
    preparedUserTurnMessage: recorder?.message,
    preparedUserTurnTranscriptRecorder: recorder,
    suppressNextUserMessagePersistence,
    onUserMessagePersisted: (message, runtimeMessage) => {
      if (runtimeMessage) {
        contexts.record(runtimeMessage, message);
      }
    },
  });
}

function submitRecorded(
  session: TestSession,
  manager: SessionManager,
  recorder: Recorder,
  contexts: Contexts | undefined,
  input: Partial<Submission>,
) {
  return submitProjection(session, {
    prependContext: undefined,
    appendContext: undefined,
    attempt: { sessionId: modelPromptSessionId, userTurnTranscriptRecorder: recorder },
    getUserTranscriptContexts: () => contexts?.list() ?? [],
    withTranscriptWrite: (write) => withSessionManagerWrite(manager, write),
    ...input,
  });
}

function continuePrompt(session: TestSession): Submission["promptActiveSession"] {
  return async (_prompt, options) => {
    options?.preflightResult?.(true);
    await session.agent.continue();
  };
}

async function transcriptUsers(target: Parameters<typeof readTranscriptMessages>[0]) {
  return (await readTranscriptMessages(target)).filter((message) => message.role === "user");
}

function submitProjection(session: TestSession, input: Partial<Submission>) {
  return submitEmbeddedAttemptPrompt({
    ...createBaseInput(),
    activeSession: session,
    promptActiveSession: (prompt, options) => session.prompt(prompt, options),
    ...input,
  });
}

function promptImages(buffer: Buffer) {
  return finalizeRuntimePromptImages([
    {
      image: { type: "image", data: buffer.toString("base64"), mimeType: "image/png" },
      factIndex: 0,
    },
  ]).images;
}

describe("durable model prompt projection at provider dispatch", () => {
  const sessionId = modelPromptSessionId;
  it.each([
    { projection: "unchanged prompt", steering: "midturn" },
    { projection: "unchanged prompt", steering: "retry" },
    { projection: "modelPrompt replacement", steering: "midturn" },
    { projection: "prepend/append hooks", steering: "initial" },
    { projection: "prepend/append hooks with log patterns", steering: "midturn" },
  ] as const)(
    "preserves complete serialized prefixes across $steering continuation, another turn, and reopen: $projection",
    async ({ projection, steering }) => {
      await withOpenClawTestState({ label: "model-prompt-projection" }, async (state) => {
        const withLogPatterns = projection === "prepend/append hooks with log patterns";
        const withImage = projection === "unchanged prompt";
        const imagePath = path.join(state.workspaceDir, "prompt-image.png");
        const imageBuffer = createSolidPngBuffer(1, 1, { r: 12, g: 34, b: 56 });
        if (withImage) {
          await fs.writeFile(imagePath, imageBuffer);
        }
        const target = await projectionTarget(state, "model-prompt-projection", withLogPatterns);
        const requests: ReturnType<typeof buildOpenAIResponsesParams>[] = [];
        let firstUserEnvelope: unknown;
        const openSession = async () => {
          const contexts = createUserTranscriptContextRegistry();
          const manager = await SessionManager.openAsync(target, state.workspaceDir);
          const result = await createTestSession({
            sessionManager: manager,
            ...(withImage ? { model: { ...testModel, input: ["text", "image"] } } : {}),
          });
          const convert = result.session.agent.convertToLlm;
          result.session.agent.convertToLlm = async (messages) => {
            const normalized = normalizeMessagesForLlmBoundary(messages, {
              sessionVersion: manager.getHeader()?.version,
              userTranscriptContexts: contexts.list(),
              timezone: "UTC",
            });
            return convert(
              withImage
                ? await hydratePromptMediaMessages(normalized, {
                    workspaceDir: state.workspaceDir,
                    model: { input: ["text", "image"] },
                    workspaceOnly: true,
                  })
                : normalized,
            );
          };
          return { ...result, contexts };
        };
        const first = await openSession();
        streamMocks.streamSimple.mockImplementation((model, context) => {
          requests.push(structuredClone(buildOpenAIResponsesParams(model, context, undefined)));
          if (requests.length === 1) {
            firstUserEnvelope = structuredClone(
              context.messages.find((message) => message.role === "user"),
            );
          }
          if (steering === "midturn" && requests.length === 1) {
            first.session.agent.steer({ role: "user", content: "queued correction", timestamp: 2 });
          }
          if (steering === "retry" && requests.length === 1) {
            return createAssistantResultStream({
              ...createAssistant(model, "Partial answer", "error"),
              errorMessage: "HTTP 503 interrupted response",
            });
          }
          return createAssistantResultStream(createAssistant(model, `answer ${requests.length}`));
        });
        const expectedProjection = (turn: number) =>
          projection === "unchanged prompt"
            ? `original turn ${turn}`
            : projection === "modelPrompt replacement"
              ? `replacement for turn ${turn}`
              : `hook before ${turn}${withLogPatterns ? " hidden" : ""}\n\noriginal turn ${turn}\n\nhook after ${turn}`;
        const submit = async (active: typeof first, turn: number) => {
          const transcriptPrompt = `original turn ${turn}`;
          const recorder = createUserTurnTranscriptRecorder({
            input: {
              text: transcriptPrompt,
              timestamp: turn,
              idempotencyKey: `projection:${turn}:user`,
              ...(withImage && turn === 1
                ? { media: [{ path: imagePath, contentType: "image/png" }] }
                : {}),
            },
            target: { ...target, sessionEntry: { sessionId, updatedAt: 1 } },
          });
          if (withImage && turn === 1) {
            // Replay adopts the persisted envelope but retains the loaded image.
            await recorder.persistApproved();
            await active.sessionManager.reloadPersistedTranscriptAsync();
          }
          guardRecorder(active.sessionManager, recorder, active.contexts, withImage && turn === 1);
          await submitRecorded(active.session, active.sessionManager, recorder, active.contexts, {
            ...(withImage && turn === 1 ? { images: promptImages(imageBuffer) } : {}),
            transcriptPrompt,
            modelPrompt: projection === "modelPrompt replacement" ? expectedProjection(turn) : "",
            prependContext:
              projection === "unchanged prompt"
                ? undefined
                : `hook before ${turn}${withLogPatterns ? " hidden" : ""}`,
            appendContext: projection === "unchanged prompt" ? undefined : `hook after ${turn}`,
          });
          expect(active.session.getLastAssistantText()).toBe(
            steering === "retry" && requests.length === 1
              ? "Partial answer"
              : `answer ${requests.length}`,
          );
          return recorder;
        };

        if (steering === "initial") {
          first.session.agent.steer({ role: "user", content: "queued correction", timestamp: 2 });
        }
        const firstRecorder = await submit(first, 1);
        let firstTurnRequests = steering === "midturn" ? 2 : 1;
        expect(requests).toHaveLength(firstTurnRequests);
        if (steering === "retry") {
          await submitRecorded(first.session, first.sessionManager, firstRecorder, first.contexts, {
            prependContext: "prepend context",
            appendContext: "append context",
            transcriptPrompt: "original turn 1",
            modelPrompt: "Changed prompt from the retry",
            images: promptImages(createSolidPngBuffer(1, 1, { r: 200, g: 100, b: 50 })),
          });
          firstTurnRequests++;
          expect(requests).toHaveLength(firstTurnRequests);
          expect(JSON.stringify(requests.at(-1))).not.toContain("Changed prompt from the retry");
        }
        await submit(first, 2);
        expect(requests).toHaveLength(firstTurnRequests + 1);
        first.session.dispose();
        const reopened = await openSession();
        await submit(reopened, 3);
        expect(requests).toHaveLength(firstTurnRequests + 2);
        if (withImage) {
          for (const request of requests) {
            expect(JSON.stringify(request).match(/"type":"input_image"/g)).toHaveLength(1);
          }
        }

        for (let index = 1; index < requests.length; index++) {
          const previous = requests[index - 1]!;
          const current = requests[index]!;
          expect(
            JSON.stringify({ ...current, input: current.input.slice(0, previous.input.length) }),
          ).toBe(JSON.stringify(previous));
        }
        const serialized = JSON.stringify(requests.at(-1));
        for (const turn of [1, 2, 3]) {
          expect(serialized).toContain(JSON.stringify(expectedProjection(turn)).slice(1, -1));
        }
        if (steering !== "retry") {
          expect(serialized).toContain("queued correction");
        }
        expect(serialized).not.toContain("modelPromptProjection");

        const users = await transcriptUsers(target);
        expect(users.map((message) => message.content)).toEqual([
          "original turn 1",
          ...(steering === "retry" ? [] : ["queued correction"]),
          "original turn 2",
          "original turn 3",
        ]);
        for (const [index, turn] of [1, 2, 3].entries()) {
          expect(users[steering === "retry" || index === 0 ? index : index + 1]).toMatchObject({
            idempotencyKey: `projection:${turn}:user`,
            __openclaw: {
              modelPromptProjection: { version: 1, text: expectedProjection(turn) },
            },
          });
        }
        if (steering !== "retry") {
          expect(users[1]).not.toHaveProperty("__openclaw.modelPromptProjection");
        }
        if (withImage) {
          expect(users[0]).toHaveProperty("__openclaw.media", [
            expect.objectContaining({ path: imagePath, contentType: "image/png" }),
          ]);
          expect(users[0]).not.toHaveProperty("__openclaw.mediaImageBlockFactIndexes");
          expect(firstUserEnvelope).toMatchObject({
            timestamp: 1,
            idempotencyKey: "projection:1:user",
            __openclaw: {
              media: [expect.objectContaining({ path: imagePath, contentType: "image/png" })],
              mediaImageBlockFactIndexes: [0],
            },
          });
        }
        if (withLogPatterns) {
          expect(JSON.stringify(requests)).toContain("hidden");
          expect(JSON.stringify(users)).toContain("hidden");
        }
      });
    },
  );

  it.each([false, true])(
    "keeps a dispatched user's projection across model fallback (enriched=%s)",
    async (enriched) => {
      await withOpenClawTestState({ label: "fallback-model-projection" }, async (state) => {
        const target = await projectionTarget(state, "fallback-model-projection");
        const original = "Keep the original user request.";
        const firstProjection = enriched ? "Original request with captured context." : original;
        const retry = "[Retry after the previous model attempt failed or timed out]\n\n" + original;
        const recorder = createUserTurnTranscriptRecorder({
          input: { text: original, timestamp: 1, idempotencyKey: "fallback:user" },
          target: { ...target, sessionEntry: undefined },
        });
        const requests: Context["messages"][] = [];
        streamMocks.streamSimple.mockImplementation((model, context) => {
          requests.push(structuredClone(context.messages));
          return createAssistantResultStream({
            ...createAssistant(
              model,
              requests.length === 1 ? "" : "done",
              requests.length === 1 ? "error" : "stop",
            ),
            ...(requests.length === 1 ? { errorMessage: "429 synthetic rate limit" } : {}),
          });
        });
        for (const stage of ["initial", "fallback"] as const) {
          const fallback = stage === "fallback";
          await using promptState = await createEmbeddedRunSessionPromptState({
            runParams: {
              ...target,
              sessionFile: target.sessionKey,
              workspaceDir: state.workspaceDir,
              prompt: fallback ? retry : original,
              runId: "fallback-projection-run",
              timeoutMs: 30_000,
              userTurnTranscriptRecorder: recorder,
              suppressNextUserMessagePersistence: recorder.hasPersisted(),
              modelRoutingProvenance: {
                requestedProvider: "test-provider",
                requestedModel: "primary",
                stage,
                ...(fallback ? { fallbackReason: "rate_limit" as const } : {}),
              },
            },
            sessionAgentId: target.agentId,
            resolvedSessionKey: target.sessionKey,
            lifecycleGeneration: "test-generation",
            onInterrupt: () => {},
          });
          const internal = promptState.activePrompt.internal;
          const contexts = createUserTranscriptContextRegistry();
          const manager = guardRecorder(
            await SessionManager.openAsync(target, state.workspaceDir),
            internal ? undefined : recorder,
            contexts,
            promptState.suppressNextUserMessagePersistence,
          );
          const { session } = await createTestSession({
            sessionManager: manager,
            model: { ...testModel, id: fallback ? "backup" : "primary" },
          });
          normalizeSession(session, () => ({
            userTranscriptContexts: contexts.list(),
            includeTimestamp: false,
          }));
          await submitRecorded(session, manager, recorder, contexts, {
            attempt: {
              sessionId,
              userTurnTranscriptRecorder: recorder,
              skipPreparedUserTurnMessage: internal,
            },
            transcriptPrompt: internal ? retry : original,
            modelPrompt: fallback ? retry : firstProjection,
          });
          const outcome = session.messages.at(-1);
          session.dispose();
          expect(outcome, JSON.stringify(outcome)).toMatchObject({
            role: "assistant",
            stopReason: fallback ? "stop" : "error",
          });
        }
        expect(requests).toHaveLength(2);
        const userText = (messages: Context["messages"]) =>
          messages.filter((message) => message.role === "user").map((message) => message.content);
        expect(userText(requests[0]!)).toEqual([firstProjection]);
        expect(userText(requests[1]!)).toEqual([firstProjection, retry]);
        expect(await transcriptUsers(target)).toEqual([
          expect.objectContaining({
            content: original,
            idempotencyKey: "fallback:user",
            __openclaw: expect.objectContaining({
              modelPromptProjection: { version: 1, text: firstProjection },
            }),
          }),
        ]);
      });
    },
  );

  it.each(["capture", "dispatch"] as const)(
    "appends late media resolved during %s without rewriting the frozen prompt",
    async (phase) => {
      await withOpenClawTestState({ label: "dispatch-late-media-projection" }, async (state) => {
        const target = {
          ...(await projectionTarget(state, "dispatch-late-media-projection")),
          sessionEntry: { sessionId, updatedAt: 1 },
        };
        const original = {
          text: "describe this image",
          timestamp: 1,
          idempotencyKey: "dispatch:user",
        };
        const imagePath = path.join(state.workspaceDir, "late-image.png");
        const media = createDeferred<UserTurnInput>();
        const resolving = createDeferred();
        const recorder = createUserTurnTranscriptRecorder({
          input: original,
          target,
          resolveInput: async () => {
            resolving.resolve();
            return await media.promise;
          },
        });
        const resolution = recorder.resolveMessage();
        await resolving.promise;
        const contexts = createUserTranscriptContextRegistry();
        const manager = guardRecorder(
          await SessionManager.openAsync(target, state.workspaceDir),
          recorder,
          contexts,
        );
        const { session } = await createTestSession({ sessionManager: manager });
        normalizeSession(session, () => ({ userTranscriptContexts: contexts.list() }));
        const requests = captureRequests();
        const releaseMedia = async () => {
          media.resolve({
            ...original,
            media: [{ path: imagePath, contentType: "image/png" }],
          });
          await resolution;
        };
        try {
          await submitRecorded(session, manager, recorder, contexts, {
            transcriptPrompt: original.text,
            modelPrompt: "enriched image request",
            withTranscriptWrite: async (write) => {
              if (phase === "capture") {
                await releaseMedia();
              }
              return withSessionManagerWrite(manager, write);
            },
            persistToolResultProjections: async () => {
              if (phase === "dispatch") {
                await releaseMedia();
              }
            },
          });
        } finally {
          media.resolve(original);
          await resolution;
        }
        // Gateway fallback persists after the foreground assistant has settled.
        await recorder.persistFallback();

        expect(requests).toHaveLength(1);
        expect(JSON.stringify(requests[0])).toContain("enriched image request");
        expect(JSON.stringify(requests[0])).not.toContain(imagePath);
        const users = await transcriptUsers(target);
        expect(users).toEqual([
          expect.objectContaining({
            content: original.text,
            idempotencyKey: original.idempotencyKey,
            __openclaw: { modelPromptProjection: { version: 1, text: "enriched image request" } },
          }),
          expect.objectContaining({
            content: "",
            idempotencyKey: `${original.idempotencyKey}:late-media`,
            __openclaw: {
              lateMedia: true,
              media: [expect.objectContaining({ path: imagePath, contentType: "image/png" })],
            },
          }),
        ]);
        expect(users[1]).not.toHaveProperty("__openclaw.modelPromptProjection");
      });
    },
  );

  it("does not transfer a compacted keyless user's projection to the retained turn", async () => {
    await withOpenClawTestState({ label: "compacted-model-prompt-projection" }, async (state) => {
      const target = {
        ...(await projectionTarget(state, "compacted-model-prompt-projection")),
        sessionEntry: { sessionId, updatedAt: 1 },
      };
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "original compacted turn", timestamp: 1 },
        target,
      });
      await recorder.persistApproved();
      const manager = await SessionManager.openAsync(target, state.workspaceDir);
      await manager.appendMessageAsync(createAssistant(testModel, "old answer"));
      const retained = await manager.appendMessageAsync({
        role: "user",
        content: "retained turn",
        timestamp: 2,
      });
      await manager.appendCompactionAsync(
        "Earlier turn was summarized.",
        expectDefined(retained, "retained user entry"),
        100,
      );
      const { session } = await createTestSession({ sessionManager: manager });
      normalizeSession(session);
      const requests = captureRequests();

      await submitRecorded(session, manager, recorder, undefined, {
        transcriptPrompt: "original compacted turn",
        modelPrompt: "enriched compacted turn",
        prependContext: "unrelated hook",
        promptActiveSession: continuePrompt(session),
      });

      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0])).toContain("retained turn");
      expect(JSON.stringify(requests[0])).toContain("Earlier turn was summarized.");
      expect(JSON.stringify(requests[0])).not.toContain("enriched compacted turn");
      expect(JSON.stringify(requests[0])).not.toContain("unrelated hook");
      expect(JSON.stringify(loadTranscriptEventsSync(target))).not.toContain(
        "modelPromptProjection",
      );
    });
  });

  it.each([
    { body: "plain", nested: false, hook: false },
    { body: "forwarded inter-session", nested: true, hook: false },
    { body: "hook", nested: false, hook: true },
  ])(
    "replays an inter-session turn with its stored provenance envelope: $body body",
    async ({ nested, hook }) => {
      await withOpenClawTestState({ label: "inter-session-model-prompt" }, async (state) => {
        const target = {
          ...(await projectionTarget(state, "inter-session-model-prompt", hook)),
          sessionEntry: { sessionId, updatedAt: 1 },
        };
        const provenance = {
          kind: "inter_session" as const,
          sourceSessionKey: "agent:main:parent",
          sourceTool: "sessions_send",
        };
        const task = "Continue the delegated task.";
        const body = nested
          ? annotateInterSessionPromptText(task, {
              kind: "inter_session",
              sourceSessionKey: "agent:main:origin",
              sourceTool: "sessions_send",
            })
          : task;
        const annotated = annotateInterSessionPromptText(body, provenance);
        const recorder = createUserTurnTranscriptRecorder({
          input: {
            text: annotated,
            timestamp: 1,
            idempotencyKey: "inter-session:user",
            provenance,
          },
          target,
        });
        await recorder.persistApproved();
        const manager = await SessionManager.openAsync(target, state.workspaceDir);
        const { session } = await createTestSession({ sessionManager: manager });
        normalizeSession(session);
        const requests = captureRequests();

        await submitRecorded(session, manager, recorder, undefined, {
          transcriptPrompt: annotated,
          modelPrompt: hook ? `hook before hidden\n\n${body}` : body,
          withTranscriptWrite: (write) => write(),
          promptActiveSession: continuePrompt(session),
        });
        session.agent.state.messages = [
          ...manager.buildSessionContext().messages,
          { role: "user", content: "next turn", timestamp: 2 },
        ];
        await session.agent.continue();

        expect(requests).toHaveLength(2);
        const firstUser = (request: (typeof requests)[number]) =>
          JSON.stringify(
            (request.input as { role?: string }[]).find((item) => item.role === "user"),
          );
        // Replay retains the safety envelope after its transient carrier disappears.
        expect(firstUser(requests[0]!)).toContain("sourceSession=agent:main:parent");
        expect(firstUser(requests[0]!)).toContain(task);
        expect(firstUser(requests[1]!)).toBe(firstUser(requests[0]!));
        // A replacement that drops the source envelope is ignored.
        expect(JSON.stringify(requests)).not.toContain("hidden");
        expect(JSON.stringify(loadTranscriptEventsSync(target))).not.toContain(
          "modelPromptProjection",
        );
      });
    },
  );
});

describe("tool-result projection persistence at dispatch", () => {
  it("writes one marker for unchanged requests and another for a new frozen batch", async () => {
    const { session: activeSession, sessionManager: manager } = await createTestSession();
    using promptStateLease = retainEmbeddedSessionPromptState(toolProjectionSessionId);
    const projectionState = promptStateLease.state.toolResults;
    const requests: Context["messages"][] = [];
    activeSession.agent.streamFn = (model, context) => {
      const persisted = createToolResultPromptProjectionState();
      restoreCacheTtlToolResultProjections(persisted, manager.getBranch());
      expect(serializeCacheTtlToolResultProjections(persisted)).toEqual(
        serializeCacheTtlToolResultProjections(projectionState),
      );
      for (const message of context.messages) {
        if (message.role === "toolResult") {
          const key = `tool:${message.toolCallId}:${message.timestamp}`;
          expect(persisted.replacements.get(key)?.content).toEqual(message.content);
        }
      }
      requests.push(structuredClone(context.messages));
      return createAssistantResultStream(createAssistant(model, "done"));
    };
    await submitProjection(activeSession, {
      attempt: { sessionId: toolProjectionSessionId },
      prependContext: undefined,
      appendContext: undefined,
      modelPrompt: "read files",
      onFinalPromptText: () => {},
      onSteeringAcknowledged: () => {},
      systemPrompt: "test prompt",
      toolResultPromptProjectionState: projectionState,
      transcriptPrompt: "read files",
      persistToolResultProjections: async () => {
        await Promise.resolve();
        await persistToolResultProjections(projectionState, (customType, data) =>
          manager.appendCustomEntryAsync(customType, data),
        );
      },
      promptActiveSession: async () => {
        const messages: Context["messages"] = [];
        for (let index = 0; index < 2; index++) {
          messages.push(createAssistant(testModel, "read"), {
            role: "toolResult",
            toolCallId: `batch-${index}`,
            toolName: "read",
            content: [{ type: "text", text: "x".repeat(6_000) }],
            isError: false,
            timestamp: index,
          });
          for (let request = 0; request < 3; request++) {
            await activeSession.agent.streamFn(testModel, { messages });
            expect(manager.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(
              index + 1,
            );
          }
        }
      },
    });
    expect(requests).toHaveLength(6);
    expect(manager.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(2);
    expect(requests[3]?.slice(0, 2)).toEqual(requests[0]);
  });
});
