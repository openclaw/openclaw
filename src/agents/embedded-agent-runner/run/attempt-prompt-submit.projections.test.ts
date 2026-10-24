import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIResponsesParams } from "../../../../packages/ai/src/transports/openai-responses-params-internal.js";
import { createSolidPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { loadSessionEntryForAdmission } from "../../../config/sessions/session-accessor.sqlite-entry-admission.js";
import { createSessionActorFactory } from "../../../config/sessions/session-actor-durable.js";
import * as messageRewrite from "../../../config/sessions/session-message-rewrite-domain.js";
import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { readDatabasePathIdentitySync } from "../../../infra/sqlite-worker-identity.js";
import type { Context } from "../../../llm/types.js";
import { finalizeRuntimePromptImages } from "../../../media/runtime-prompt-image-provenance.js";
import { annotateInterSessionPromptText } from "../../../sessions/input-provenance.js";
import {
  createUserTurnTranscriptRecorder,
  type UserTurnInput,
} from "../../../sessions/user-turn-transcript.js";
import {
  isUserMessage,
  readModelPromptProjection,
} from "../../../sessions/user-turn-transcript.message.js";
import { readTranscriptMessages } from "../../../sessions/user-turn-transcript.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { RESTART_RECOVERY_INTERRUPTION_NOTE } from "../../restart-recovery-prompt.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "../../sessions/agent-session-loop-resource-loader.test-support.js";
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
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";
import { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";

registerAgentSessionLoopTestLifecycle();
const toolProjectionSessionId = "projection-dispatch";
const sessionId = modelPromptSessionId;

async function prepareTarget(state: OpenClawTestState, label: string, config?: OpenClawConfig) {
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${label}`,
    storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    ...(config ? { config } : {}),
  };
  setRuntimeConfigSnapshot(config ?? {});
  await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
  return target;
}

type Session = Awaited<ReturnType<typeof createTestSession>>["session"];
type Submission = Parameters<typeof submitEmbeddedAttemptPrompt>[0];
function submit(session: Session, input: Partial<Submission>) {
  return submitEmbeddedAttemptPrompt({
    ...createBaseInput(),
    activeSession: session,
    withTranscriptWrite: (write) => withSessionManagerWrite(session.sessionManager, write),
    promptActiveSession: (prompt, options) => session.prompt(prompt, options),
    ...input,
  });
}

function normalizeSession(
  session: Session,
  options: () => Parameters<typeof normalizeMessagesForLlmBoundary>[1] = () => undefined,
) {
  const convert = session.agent.convertToLlm;
  session.agent.convertToLlm = (messages) =>
    convert(normalizeMessagesForLlmBoundary(messages, options()));
}

afterEach(() => {
  clearEmbeddedSessionPromptStates([toolProjectionSessionId, modelPromptSessionId]);
});

function captureRequests() {
  const requests: ReturnType<typeof buildOpenAIResponsesParams>[] = [];
  streamMocks.streamSimple.mockImplementation((model, context) => {
    requests.push(buildOpenAIResponsesParams(model, context, undefined));
    return createAssistantResultStream(createAssistant(model, [{ type: "text", text: "done" }]));
  });
  return requests;
}

function promptImages(buffer: Buffer) {
  return finalizeRuntimePromptImages([
    {
      image: { type: "image" as const, data: buffer.toString("base64"), mimeType: "image/png" },
      factIndex: 0,
    },
  ]).images;
}

describe("durable model prompt projection at provider dispatch", () => {
  it("commits final listener text with its actor carrier without a separate rewrite request", async () => {
    await withOpenClawTestState({ label: "actor-prompt-projection" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId,
        sessionKey: "agent:main:actor-prompt-projection",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
      const { databaseClaim } = await loadSessionEntryForAdmission(target);
      if (!("kind" in databaseClaim) || databaseClaim.kind !== "worker" || !databaseClaim.reader) {
        throw new Error("Expected an admitted durable reader");
      }
      const reader = databaseClaim.reader;
      const identity = readDatabasePathIdentitySync(reader.database.path);
      if (!identity.key.startsWith("file:")) {
        throw new Error("Expected a physical actor database");
      }
      const assertCurrent = () => reader.assertCurrent();
      const actor = await createSessionActorFactory(reader.database).acquire(
        {
          sessionKey: target.sessionKey,
          database: {
            kind: "file",
            physicalIdentity: identity.key.slice(5),
            birthtime: identity.birthtime,
            nativeLocation: reader.database.path,
          },
        },
        { assertCurrent, assertReadable: assertCurrent },
      );
      if ("kind" in actor) {
        throw new Error("Expected a durable session actor");
      }
      const rewrite = vi.spyOn(messageRewrite, "executeSessionMessageRewriteOperation");
      try {
        await actor.read({ assertCurrent, authorize: assertCurrent });
        await withOwnedSessionTranscriptWrites(
          {
            sessionTarget: target,
            sessionReader: reader,
            sessionActor: { actor, database: reader.database },
            withTranscriptWrite: async (write) => write(),
          },
          async () => {
            const manager = await SessionManager.openAsync(target, state.workspaceDir);
            const contexts = createUserTranscriptContextRegistry();
            const recorder = createUserTurnTranscriptRecorder({
              input: { text: "original", timestamp: 1, idempotencyKey: "actor-projection:user" },
              target: { ...target, sessionEntry: { sessionId, updatedAt: 1 } },
            });
            const { session } = await createTestSession({
              sessionManager: manager,
              resourceLoader: await createResourceLoader((api) => {
                api.on("message_end", async (event: unknown) => {
                  if (
                    typeof event === "object" &&
                    event !== null &&
                    "message" in event &&
                    isUserMessage(event.message)
                  ) {
                    return { message: { ...event.message, content: "extension text" } };
                  }
                  return undefined;
                });
              }),
            });
            const convert = session.agent.convertToLlm;
            session.agent.convertToLlm = async (messages) =>
              convert(
                normalizeMessagesForLlmBoundary(messages, {
                  sessionVersion: manager.getHeader()?.version,
                  userTranscriptContexts: contexts.list(),
                  timezone: "UTC",
                }),
              );
            session.subscribe((event) => {
              if (
                event.type === "message_end" &&
                event.message.role === "user" &&
                typeof event.message.content === "string"
              ) {
                event.message.content = `listener after ${event.message.content}`;
              }
            });
            guardSessionManager(manager, {
              preparedUserTurnMessage: recorder.message,
              preparedUserTurnTranscriptRecorder: recorder,
              onUserMessagePersisted: (message, runtimeMessage) => {
                if (runtimeMessage) {
                  contexts.record(runtimeMessage, message);
                }
              },
            });
            const requests: Context["messages"][] = [];
            streamMocks.streamSimple.mockImplementation((model, context) => {
              requests.push(structuredClone(context.messages));
              return createAssistantResultStream(createAssistant(model, "done"));
            });
            await submit(session, {
              attempt: { sessionId, userTurnTranscriptRecorder: recorder },
              appendOnlyRuntimeContext: true,
              runtimeContextMessage: buildRuntimeContextCustomMessage("Synthetic runtime"),
              transcriptPrompt: "original",
              modelPrompt: "",
              prependContext: "before",
              appendContext: "after",
              getUserTranscriptContexts: () => contexts.list(),
            });
            expect(rewrite).not.toHaveBeenCalled();
            expect(session.getLastAssistantText()).toBe("done");
            const expected = "before\n\nlistener after extension text\n\nafter";
            expect(requests).toHaveLength(1);
            expect(JSON.stringify(requests[0])).toContain(expected.replaceAll("\n", "\\n"));
            expect(readModelPromptProjection(recorder.getPersistedMessage?.())).toBe(expected);
            const entries = manager.getEntries();
            const user = entries.find(
              (entry) => entry.type === "message" && entry.message.role === "user",
            );
            expect(user).toMatchObject({
              type: "message",
              message: { __openclaw: { modelPromptProjection: { version: 1, text: expected } } },
            });
            expect(entries).toContainEqual(
              expect.objectContaining({
                type: "custom_message",
                customType: "openclaw.runtime-context",
                parentId: user?.id,
                content: "Synthetic runtime",
              }),
            );
            session.dispose();
            const reopened = await SessionManager.openAsync(target, state.workspaceDir);
            expect(reopened.getEntries()).toEqual(entries);
          },
        );
      } finally {
        rewrite.mockRestore();
        await actor.release();
        await databaseClaim.release();
      }
    });
  });

  it("preserves image-bearing request prefixes across retries, later turns, and reopen", async () => {
    await withOpenClawTestState({ label: "model-prompt-projection" }, async (state) => {
      const imagePath = path.join(state.workspaceDir, "prompt-image.png");
      const imageBuffer = createSolidPngBuffer(1, 1, { r: 12, g: 34, b: 56 });
      await fs.writeFile(imagePath, imageBuffer);
      const target = await prepareTarget(state, "model-prompt-projection");
      const requests: ReturnType<typeof buildOpenAIResponsesParams>[] = [];
      const openSession = async () => {
        const contexts = createUserTranscriptContextRegistry();
        const manager = await SessionManager.openAsync(target, state.workspaceDir);
        const { session } = await createTestSession({
          sessionManager: manager,
          model: { ...testModel, input: ["text", "image"] },
        });
        const convert = session.agent.convertToLlm;
        session.agent.convertToLlm = async (messages) =>
          convert(
            await hydratePromptMediaMessages(
              normalizeMessagesForLlmBoundary(messages, {
                sessionVersion: manager.getHeader()?.version,
                userTranscriptContexts: contexts.list(),
                timezone: "UTC",
              }),
              {
                workspaceDir: state.workspaceDir,
                model: { input: ["text", "image"] },
                workspaceOnly: true,
              },
            ),
          );
        return { session, manager, contexts };
      };
      streamMocks.streamSimple.mockImplementation((model, context) => {
        requests.push(structuredClone(buildOpenAIResponsesParams(model, context, undefined)));
        return createAssistantResultStream(
          requests.length === 1
            ? {
                ...createAssistant(model, [{ type: "text", text: "Partial answer" }], "error"),
                errorMessage: "HTTP 503 interrupted response",
              }
            : createAssistant(model, [{ type: "text", text: "done" }]),
        );
      });
      const send = async (active: Awaited<ReturnType<typeof openSession>>, turn: number) => {
        const text = `original turn ${turn}`;
        const recorder = createUserTurnTranscriptRecorder({
          input: {
            text,
            timestamp: turn,
            idempotencyKey: `projection:${turn}:user`,
            ...(turn === 1 ? { media: [{ path: imagePath, contentType: "image/png" }] } : {}),
          },
          target: { ...target, sessionEntry: { sessionId, updatedAt: 1 } },
        });
        if (turn === 1) {
          await recorder.persistApproved();
          await active.manager.reloadPersistedTranscriptAsync();
        }
        guardSessionManager(active.manager, {
          preparedUserTurnMessage: recorder.message,
          preparedUserTurnTranscriptRecorder: recorder,
          suppressNextUserMessagePersistence: turn === 1,
          onUserMessagePersisted: (message, runtimeMessage) => {
            if (runtimeMessage) {
              active.contexts.record(runtimeMessage, message);
            }
          },
        });
        await submit(active.session, {
          attempt: { sessionId, userTurnTranscriptRecorder: recorder },
          ...(turn === 1 ? { images: promptImages(imageBuffer) } : {}),
          transcriptPrompt: text,
          modelPrompt: "",
          prependContext: undefined,
          appendContext: undefined,
          getUserTranscriptContexts: () => active.contexts.list(),
        });
        expect(active.session.getLastAssistantText()).toBe(turn === 1 ? "Partial answer" : "done");
        return recorder;
      };
      const first = await openSession();
      const recorder = await send(first, 1);
      await submit(first.session, {
        attempt: { sessionId, userTurnTranscriptRecorder: recorder },
        transcriptPrompt: "original turn 1",
        modelPrompt: "Changed prompt from the retry",
        images: promptImages(createSolidPngBuffer(1, 1, { r: 200, g: 100, b: 50 })),
        getUserTranscriptContexts: () => first.contexts.list(),
      });
      expect(first.session.getLastAssistantText()).toBe("done");
      expect(JSON.stringify(requests[1])).not.toContain("Changed prompt from the retry");
      await send(first, 2);
      first.session.dispose();
      const reopened = await openSession();
      await send(reopened, 3);
      expect(requests).toHaveLength(4);
      for (const request of requests) {
        expect(JSON.stringify(request).match(/"type":"input_image"/g)).toHaveLength(1);
      }
      for (let index = 1; index < requests.length; index++) {
        const previous = requests[index - 1]!;
        const current = requests[index]!;
        expect(
          JSON.stringify({ ...current, input: current.input.slice(0, previous.input.length) }),
        ).toBe(JSON.stringify(previous));
      }
      const serialized = JSON.stringify(requests.at(-1));
      const users = (await readTranscriptMessages(target)).filter(
        (message) => message.role === "user",
      );
      expect(users).toHaveLength(3);
      for (const [index, message] of users.entries()) {
        const text = `original turn ${index + 1}`;
        expect(serialized).toContain(text);
        expect(message).toMatchObject({
          content: text,
          idempotencyKey: `projection:${index + 1}:user`,
          __openclaw: { modelPromptProjection: { version: 1, text } },
        });
      }
      expect(serialized).not.toContain("modelPromptProjection");
      expect(users[0]).toHaveProperty("__openclaw.media", [
        expect.objectContaining({ path: imagePath, contentType: "image/png" }),
      ]);
      expect(users[0]).not.toHaveProperty("__openclaw.mediaImageBlockFactIndexes");
    });
  });

  it.each([false, true])(
    "keeps a dispatched user's projection across model fallback (enriched=%s)",
    async (enriched) => {
      await withOpenClawTestState({ label: "fallback-model-projection" }, async (state) => {
        const target = await prepareTarget(state, "fallback-model-projection");
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
              [{ type: "text", text: requests.length === 1 ? "" : "done" }],
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
              modelRoutingProvenance: fallback
                ? {
                    requestedProvider: "test-provider",
                    requestedModel: "primary",
                    stage,
                    fallbackReason: "rate_limit",
                  }
                : { requestedProvider: "test-provider", requestedModel: "primary", stage },
            },
            sessionAgentId: target.agentId,
            resolvedSessionKey: target.sessionKey,
            lifecycleGeneration: "test-generation",
            onInterrupt: () => {},
          });
          const internal = promptState.activePrompt.internal;
          const contexts = createUserTranscriptContextRegistry();
          const manager = guardSessionManager(
            await SessionManager.openAsync(target, state.workspaceDir),
            {
              preparedUserTurnMessage: internal ? undefined : recorder.message,
              preparedUserTurnTranscriptRecorder: internal ? undefined : recorder,
              suppressNextUserMessagePersistence: promptState.suppressNextUserMessagePersistence,
              onUserMessagePersisted: (message, runtimeMessage) => {
                if (runtimeMessage) {
                  contexts.record(runtimeMessage, message);
                }
              },
            },
          );
          const { session } = await createTestSession({
            sessionManager: manager,
            model: { ...testModel, id: fallback ? "backup" : "primary" },
          });
          normalizeSession(session, () => ({
            userTranscriptContexts: contexts.list(),
            includeTimestamp: false,
          }));
          await submit(session, {
            attempt: {
              sessionId,
              userTurnTranscriptRecorder: recorder,
              skipPreparedUserTurnMessage: internal,
            },
            transcriptPrompt: internal ? retry : original,
            modelPrompt: fallback ? retry : firstProjection,
            prependContext: undefined,
            appendContext: undefined,
            getUserTranscriptContexts: () => contexts.list(),
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
        const users = (await readTranscriptMessages(target)).filter(
          (message) => message.role === "user",
        );
        expect(users).toHaveLength(1);
        expect(users[0]).toMatchObject({ content: original, idempotencyKey: "fallback:user" });
        expect(users[0]).toHaveProperty("__openclaw.modelPromptProjection", {
          version: 1,
          text: firstProjection,
        });
      });
    },
  );

  it.each(["capture", "dispatch"] as const)(
    "appends late media resolved during %s without rewriting the frozen prompt",
    async (phase) => {
      await withOpenClawTestState({ label: "dispatch-late-media-projection" }, async (state) => {
        const target = {
          ...(await prepareTarget(state, "dispatch-late-media-projection")),
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
        const manager = guardSessionManager(
          await SessionManager.openAsync(target, state.workspaceDir),
          {
            preparedUserTurnMessage: recorder.message,
            preparedUserTurnTranscriptRecorder: recorder,
            onUserMessagePersisted: (message, runtimeMessage) => {
              if (runtimeMessage) {
                contexts.record(runtimeMessage, message);
              }
            },
          },
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
          await submit(session, {
            attempt: { sessionId, userTurnTranscriptRecorder: recorder },
            transcriptPrompt: original.text,
            modelPrompt: "enriched image request",
            prependContext: undefined,
            appendContext: undefined,
            getUserTranscriptContexts: () => contexts.list(),
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
        const users = (await readTranscriptMessages(target)).filter(
          (message) => message.role === "user",
        );
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
        ...(await prepareTarget(state, "compacted-model-prompt-projection")),
        sessionEntry: { sessionId, updatedAt: 1 },
      };
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "original compacted turn", timestamp: 1 },
        target,
      });
      await recorder.persistApproved();
      const manager = await SessionManager.openAsync(target, state.workspaceDir);
      await manager.appendMessageAsync(
        createAssistant(testModel, [{ type: "text", text: "old answer" }]),
      );
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

      await submit(session, {
        attempt: { sessionId, userTurnTranscriptRecorder: recorder },
        transcriptPrompt: "original compacted turn",
        modelPrompt: "enriched compacted turn",
        prependContext: "unrelated hook",
        appendContext: undefined,
        getUserTranscriptContexts: () => [],
        promptActiveSession: async (_prompt, options) => {
          options?.preflightResult?.(true);
          await session.agent.continue();
        },
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
    { body: "plain", nested: false, hook: false, restart: false },
    { body: "forwarded inter-session", nested: true, hook: false, restart: false },
    { body: "hook", nested: false, hook: true, restart: false },
    { body: "restart with frozen prompt", nested: false, hook: false, restart: true },
  ])(
    "replays an inter-session turn with its stored provenance envelope: $body body",
    async ({ nested, hook, restart }) => {
      await withOpenClawTestState({ label: "inter-session-model-prompt" }, async (state) => {
        const target = {
          ...(await prepareTarget(
            state,
            "inter-session-model-prompt",
            hook ? { logging: { redactPatterns: ["hidden"] } } : undefined,
          )),
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
        if (restart) {
          await recorder.captureModelPromptProjection!(annotated, () => {});
        }
        const manager = await SessionManager.openAsync(target, state.workspaceDir);
        const { session } = await createTestSession({ sessionManager: manager });
        normalizeSession(session);
        const requests = captureRequests();

        // The first request keeps the same stored provenance envelope as replay.
        await submit(session, {
          attempt: { sessionId, userTurnTranscriptRecorder: recorder },
          transcriptPrompt: annotated,
          modelPrompt: hook ? `hook before hidden\n\n${body}` : body,
          runtimeContextMessage: restart
            ? buildRuntimeContextCustomMessage(RESTART_RECOVERY_INTERRUPTION_NOTE, [
                { kind: "runtime-instruction", text: RESTART_RECOVERY_INTERRUPTION_NOTE },
              ])
            : undefined,
          prependContext: undefined,
          appendContext: undefined,
          getUserTranscriptContexts: () => [],
          withTranscriptWrite: (write) => write(),
          promptActiveSession: async (_prompt, options) => {
            options?.preflightResult?.(true);
            await session.agent.continue();
          },
        });
        session.agent.state.messages = [
          ...manager.buildSessionContext().messages,
          { role: "user", content: "next turn", timestamp: 2 },
        ];
        await session.agent.continue();

        expect(requests).toHaveLength(2);
        const firstUser = (request: (typeof requests)[number]) =>
          JSON.stringify(
            (request.input as { role?: string }[]).find(
              (item) => item.role === "user" && JSON.stringify(item).includes(task),
            ),
          );
        // The first send already carries the stored safety envelope, so replay keeps its bytes
        // and the envelope stays visible once the transient carrier is gone.
        expect(firstUser(requests[0]!)).toContain("sourceSession=agent:main:parent");
        expect(firstUser(requests[0]!)).toContain(task);
        expect(firstUser(requests[1]!)).toBe(firstUser(requests[0]!));
        // A replacement that drops the source envelope is ignored.
        expect(JSON.stringify(requests)).not.toContain("hidden");
        if (restart) {
          expect(
            JSON.stringify(requests[0]).split(RESTART_RECOVERY_INTERRUPTION_NOTE),
          ).toHaveLength(2);
          expect(JSON.stringify(requests[1])).not.toContain(RESTART_RECOVERY_INTERRUPTION_NOTE);
          expect(readModelPromptProjection(recorder.getPersistedMessage!())).toBe(annotated);
        } else {
          expect(JSON.stringify(loadTranscriptEventsSync(target))).not.toContain(
            "modelPromptProjection",
          );
        }
      });
    },
  );
});

describe("tool-result projection persistence at dispatch", () => {
  it("writes one marker for unchanged requests and another for a new frozen batch", async () => {
    const { session: activeSession, sessionManager: manager } = await createTestSession();
    using promptStateLease = retainEmbeddedSessionPromptState(toolProjectionSessionId);
    const sessionPromptState = promptStateLease.state;
    const projectionState = sessionPromptState.toolResults;
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
      return createAssistantResultStream(createAssistant(model, [{ type: "text", text: "done" }]));
    };
    await submitEmbeddedAttemptPrompt({
      attempt: { sessionId: toolProjectionSessionId },
      contextTokenBudget: 8_000,
      images: [],
      modelPrompt: "read files",
      onFinalPromptText: () => {},
      runtimeOnly: false,
      systemPrompt: "test prompt",
      toolResultAggregateMaxChars: 8_000,
      toolResultMaxChars: 4_000,
      toolResultPromptProjectionState: projectionState,
      trajectoryRecorder: null,
      transcriptLeafId: null,
      transcriptPrompt: "read files",
      activeSession,
      persistToolResultProjections: async () => {
        await Promise.resolve();
        await persistToolResultProjections(projectionState, (customType, data) =>
          manager.appendCustomEntryAsync(customType, data),
        );
      },
      promptActiveSession: async () => {
        const messages: Context["messages"] = [];
        for (let index = 0; index < 2; index++) {
          messages.push(createAssistant(testModel, [{ type: "text", text: "read" }]), {
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
