import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { buildOpenAIResponsesParams } from "../../../../packages/ai/src/transports/openai-responses-params-internal.js";
import { createSolidPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
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
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
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
  getEmbeddedSessionPromptState,
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

describe("durable model prompt projection at provider dispatch", () => {
  const sessionId = modelPromptSessionId;
  it.each([
    { projection: "unchanged prompt", steering: "midturn" },
    { projection: "prepend/append hooks", steering: "midturn" },
    { projection: "modelPrompt replacement", steering: "midturn" },
    { projection: "prepend/append hooks", steering: "initial" },
    { projection: "redacted prepend/append hooks", steering: "midturn" },
  ] as const)(
    "preserves complete serialized prefixes across $steering steering, another turn, and reopen: $projection",
    async ({ projection, steering }) => {
      await withOpenClawTestState({ label: "model-prompt-projection" }, async (state) => {
        const redactHook = projection === "redacted prepend/append hooks";
        const withImage = projection === "unchanged prompt";
        const imagePath = path.join(state.workspaceDir, "prompt-image.png");
        const imageBuffer = createSolidPngBuffer(1, 1, { r: 12, g: 34, b: 56 });
        if (withImage) {
          await fs.writeFile(imagePath, imageBuffer);
        }
        const target = {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:model-prompt-projection",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
          ...(redactHook ? { config: { logging: { redactPatterns: ["hidden"] } } } : {}),
        };
        await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
        const requests: ReturnType<typeof buildOpenAIResponsesParams>[] = [];
        const userEnvelopes: string[][] = [];
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
          return { ...result, contexts, getUserTranscriptContexts: () => contexts.list() };
        };
        const first = await openSession();
        streamMocks.streamSimple.mockImplementation((model, context) => {
          requests.push(structuredClone(buildOpenAIResponsesParams(model, context, undefined)));
          userEnvelopes.push(
            context.messages
              .filter((message) => message.role === "user")
              .map((message) => JSON.stringify(message)),
          );
          if (steering === "midturn" && requests.length === 1) {
            first.session.agent.steer({ role: "user", content: "queued correction", timestamp: 2 });
          }
          return createAssistantResultStream(
            createAssistant(model, [{ type: "text", text: `answer ${requests.length}` }]),
          );
        });
        const expectedProjection = (turn: number) =>
          projection === "unchanged prompt"
            ? `original turn ${turn}`
            : projection === "modelPrompt replacement"
              ? `replacement for turn ${turn}`
              : `hook before ${turn}${redactHook ? " ***" : ""}\n\noriginal turn ${turn}\n\nhook after ${turn}`;
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
            // Admission precedes guard installation, as in current-turn replay.
            // Suppressed persistence must adopt the row's envelope without
            // losing ownership of the already loaded image.
            await recorder.persistApproved();
            await active.sessionManager.reloadPersistedTranscriptAsync();
          }
          guardSessionManager(active.sessionManager, {
            preparedUserTurnMessage: recorder.message,
            preparedUserTurnTranscriptRecorder: recorder,
            suppressNextUserMessagePersistence: withImage && turn === 1,
            onUserMessagePersisted: (message, runtimeMessage) => {
              if (runtimeMessage) {
                active.contexts.record(runtimeMessage, message);
              }
            },
          });
          await submitEmbeddedAttemptPrompt({
            ...createBaseInput(),
            attempt: { sessionId, userTurnTranscriptRecorder: recorder },
            ...(withImage && turn === 1
              ? {
                  images: finalizeRuntimePromptImages([
                    {
                      image: {
                        type: "image" as const,
                        data: imageBuffer.toString("base64"),
                        mimeType: "image/png",
                      },
                      factIndex: 0,
                    },
                  ]).images,
                }
              : {}),
            activeSession: active.session,
            transcriptPrompt,
            modelPrompt: projection === "modelPrompt replacement" ? expectedProjection(turn) : "",
            prependContext:
              projection === "unchanged prompt"
                ? undefined
                : `hook before ${turn}${redactHook ? " hidden" : ""}`,
            appendContext: projection === "unchanged prompt" ? undefined : `hook after ${turn}`,
            getUserTranscriptContexts: active.getUserTranscriptContexts,
            withTranscriptWrite: (write) => withSessionManagerWrite(active.sessionManager, write),
            promptActiveSession: (prompt, options) => active.session.prompt(prompt, options),
          });
          expect(
            active.session.getLastAssistantText(),
            JSON.stringify(
              active.session.messages.flatMap((message) =>
                message.role === "assistant"
                  ? [{ stopReason: message.stopReason, errorMessage: message.errorMessage }]
                  : [],
              ),
            ),
          ).toBe(`answer ${requests.length}`);
        };

        if (steering === "initial") {
          first.session.agent.steer({ role: "user", content: "queued correction", timestamp: 2 });
        }
        await submit(first, 1);
        const firstTurnRequests = steering === "midturn" ? 2 : 1;
        expect(requests).toHaveLength(firstTurnRequests);
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
          const previousUsers = userEnvelopes[index - 1]!;
          expect(userEnvelopes[index]!.slice(0, previousUsers.length)).toEqual(previousUsers);
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
        expect(serialized).toContain("queued correction");
        expect(serialized).not.toContain("modelPromptProjection");

        const users = (await readTranscriptMessages(target)).filter(
          (message) => message.role === "user",
        );
        expect(users.map((message) => message.content)).toEqual([
          "original turn 1",
          "queued correction",
          "original turn 2",
          "original turn 3",
        ]);
        for (const [index, turn] of [1, 2, 3].entries()) {
          expect(users[index === 0 ? 0 : index + 1]).toMatchObject({
            idempotencyKey: `projection:${turn}:user`,
            ...(projection === "unchanged prompt"
              ? {}
              : {
                  __openclaw: {
                    modelPromptProjection: { version: 1, text: expectedProjection(turn) },
                  },
                }),
          });
        }
        expect(users[1]).not.toHaveProperty("__openclaw.modelPromptProjection");
        if (withImage) {
          expect(users[0]).toHaveProperty("__openclaw.media", [
            expect.objectContaining({ path: imagePath, contentType: "image/png" }),
          ]);
          expect(users[0]).not.toHaveProperty("__openclaw.mediaImageBlockFactIndexes");
          expect(JSON.parse(userEnvelopes[0]![0]!)).toMatchObject({
            timestamp: 1,
            idempotencyKey: "projection:1:user",
            __openclaw: {
              media: [expect.objectContaining({ path: imagePath, contentType: "image/png" })],
              mediaImageBlockFactIndexes: [0],
            },
          });
        }
        if (redactHook) {
          expect(JSON.stringify(requests)).not.toContain("hidden");
          expect(JSON.stringify(users)).not.toContain("hidden");
        }
      });
    },
  );

  it.each([false, true])(
    "keeps a dispatched user's projection across model fallback (enriched=%s)",
    async (enriched) => {
      await withOpenClawTestState({ label: "fallback-model-projection" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:fallback-model-projection",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        };
        await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
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
          const convert = session.agent.convertToLlm;
          session.agent.convertToLlm = (messages) =>
            convert(
              normalizeMessagesForLlmBoundary(messages, {
                userTranscriptContexts: contexts.list(),
                includeTimestamp: false,
              }),
            );
          await submitEmbeddedAttemptPrompt({
            ...createBaseInput(),
            attempt: {
              sessionId,
              userTurnTranscriptRecorder: recorder,
              skipPreparedUserTurnMessage: internal,
            },
            activeSession: session,
            transcriptPrompt: internal ? retry : original,
            modelPrompt: fallback ? retry : firstProjection,
            prependContext: undefined,
            appendContext: undefined,
            getUserTranscriptContexts: () => contexts.list(),
            withTranscriptWrite: (write) => withSessionManagerWrite(manager, write),
            promptActiveSession: (prompt, options) => session.prompt(prompt, options),
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
        if (enriched) {
          expect(users[0]).toHaveProperty("__openclaw.modelPromptProjection", {
            version: 1,
            text: firstProjection,
          });
        } else {
          expect(users[0]).not.toHaveProperty("__openclaw.modelPromptProjection");
        }
      });
    },
  );

  it.each(["capture", "dispatch"] as const)(
    "appends late media resolved during %s without rewriting the frozen prompt",
    async (phase) => {
      await withOpenClawTestState({ label: "dispatch-late-media-projection" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:dispatch-late-media-projection",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
          sessionEntry: { sessionId, updatedAt: 1 },
        };
        await upsertSessionEntryCore(target, target.sessionEntry);
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
        const convert = session.agent.convertToLlm;
        session.agent.convertToLlm = (messages) =>
          convert(
            normalizeMessagesForLlmBoundary(messages, { userTranscriptContexts: contexts.list() }),
          );
        const requests: ReturnType<typeof buildOpenAIResponsesParams>[] = [];
        streamMocks.streamSimple.mockImplementation((model, context) => {
          requests.push(buildOpenAIResponsesParams(model, context, undefined));
          return createAssistantResultStream(
            createAssistant(model, [{ type: "text", text: "done" }]),
          );
        });
        const releaseMedia = async () => {
          media.resolve({
            ...original,
            media: [{ path: imagePath, contentType: "image/png" }],
          });
          await resolution;
        };
        try {
          await submitEmbeddedAttemptPrompt({
            ...createBaseInput(),
            attempt: { sessionId, userTurnTranscriptRecorder: recorder },
            activeSession: session,
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
            promptActiveSession: (prompt, options) => session.prompt(prompt, options),
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
        agentId: "main",
        sessionId,
        sessionKey: "agent:main:compacted-model-prompt-projection",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        sessionEntry: { sessionId, updatedAt: 1 },
      };
      await upsertSessionEntryCore(target, target.sessionEntry);
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
      const convert = session.agent.convertToLlm;
      session.agent.convertToLlm = (messages) => convert(normalizeMessagesForLlmBoundary(messages));
      const requests: ReturnType<typeof buildOpenAIResponsesParams>[] = [];
      streamMocks.streamSimple.mockImplementation((model, context) => {
        requests.push(buildOpenAIResponsesParams(model, context, undefined));
        return createAssistantResultStream(
          createAssistant(model, [{ type: "text", text: "done" }]),
        );
      });

      await submitEmbeddedAttemptPrompt({
        ...createBaseInput(),
        activeSession: session,
        attempt: { sessionId, userTurnTranscriptRecorder: recorder },
        transcriptPrompt: "original compacted turn",
        modelPrompt: "enriched compacted turn",
        prependContext: "unrelated hook",
        appendContext: undefined,
        getUserTranscriptContexts: () => [],
        withTranscriptWrite: (write) => withSessionManagerWrite(manager, write),
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
    { body: "plain", nested: false },
    { body: "forwarded inter-session", nested: true },
  ])(
    "replays an inter-session turn with its stored provenance envelope: $body body",
    async ({ nested }) => {
      await withOpenClawTestState({ label: "inter-session-model-prompt" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:inter-session-model-prompt",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
          sessionEntry: { sessionId, updatedAt: 1 },
        };
        await upsertSessionEntryCore(target, target.sessionEntry);
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
        const convert = session.agent.convertToLlm;
        session.agent.convertToLlm = (messages) =>
          convert(normalizeMessagesForLlmBoundary(messages));
        const requests: ReturnType<typeof buildOpenAIResponsesParams>[] = [];
        streamMocks.streamSimple.mockImplementation((model, context) => {
          requests.push(buildOpenAIResponsesParams(model, context, undefined));
          return createAssistantResultStream(
            createAssistant(model, [{ type: "text", text: "done" }]),
          );
        });

        // The active turn sends the routed body; its provenance travels in runtime context.
        await submitEmbeddedAttemptPrompt({
          ...createBaseInput(),
          activeSession: session,
          attempt: { sessionId, userTurnTranscriptRecorder: recorder },
          transcriptPrompt: annotated,
          modelPrompt: body,
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
        // History keeps the stored safety envelope once the transient carrier is gone.
        expect(JSON.stringify(requests[1])).toContain("sourceSession=agent:main:parent");
        expect(JSON.stringify(loadTranscriptEventsSync(target))).not.toContain(
          "modelPromptProjection",
        );
      });
    },
  );
});

describe("tool-result projection persistence at dispatch", () => {
  it("restores only the active branch and retries changed projections after a failed write", async () => {
    const { sessionManager: manager } = await createTestSession();
    const snapshot = (key: string) => ({
      prunedToolResults: [],
      ambiguousToolResultBaseKeys: [],
      frozenToolResults: [{ key, sourceHash: "source", texts: [key] }],
    });
    await manager.appendCustomEntryAsync("openclaw.cache-ttl", snapshot("older"));
    const activeMarker = await manager.appendCustomEntryAsync(
      "openclaw.cache-ttl",
      snapshot("active"),
    );
    await manager.appendCustomEntryAsync("openclaw.cache-ttl", snapshot("sibling"));
    await manager.branchAsync(activeMarker);

    const restored = createToolResultPromptProjectionState();
    restoreCacheTtlToolResultProjections(restored, manager.getBranch());
    expect(serializeCacheTtlToolResultProjections(restored)).toEqual(snapshot("active"));
    const appendEntry = (customType: string, data: unknown) =>
      manager.appendCustomEntryAsync(customType, data);
    const markers = () =>
      manager
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === "openclaw.cache-ttl");
    await persistToolResultProjections(restored, appendEntry);
    expect(markers()).toHaveLength(3);

    restored.replacements.set("active", { content: [{ type: "text", text: "changed" }] });
    await expect(
      persistToolResultProjections(restored, async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");
    await persistToolResultProjections(restored, appendEntry);
    await persistToolResultProjections(restored, appendEntry);
    expect(markers()).toHaveLength(4);
    const reopened = createToolResultPromptProjectionState();
    restoreCacheTtlToolResultProjections(reopened, manager.getBranch());
    expect(serializeCacheTtlToolResultProjections(reopened)).toEqual({
      ...snapshot("active"),
      frozenToolResults: [{ key: "active", sourceHash: "source", texts: ["changed"] }],
    });
  });

  it("writes one marker for unchanged requests and another for a new frozen batch", async () => {
    const { session: activeSession, sessionManager: manager } = await createTestSession();
    const sessionPromptState = getEmbeddedSessionPromptState(toolProjectionSessionId);
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
      onSteeringAcknowledged: () => {},
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
