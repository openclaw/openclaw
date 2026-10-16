import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import type { Context } from "../../../llm/types.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { RUNTIME_EVENT_USER_PROMPT } from "../../internal-runtime-context.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { SettingsManager } from "../../sessions/settings-manager.js";
import { resolveTranscriptPolicy } from "../../transcript-policy.js";
import { clearEmbeddedSessionPromptStates } from "../session-prompt-state.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { createBaseInput, sessionId } from "./attempt-prompt-submit.test-support.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";

registerAgentSessionLoopTestLifecycle();

afterEach(() => {
  clearEmbeddedSessionPromptStates([sessionId]);
});

describe("submitEmbeddedAttemptPrompt runtime replay", () => {
  it.each([
    { name: "transient override", api: "openai-completions", override: false, retained: false },
    { name: "retained override", api: "openai-completions", override: true, retained: true },
    { name: "generic completions", api: "openai-completions", retained: true },
    { name: "native Ollama", api: "ollama", retained: true },
  ])(
    "preserves hidden runtime input across provider retry and cold session reopen: $name",
    async ({ api, override, retained }) => {
      const { appendOnlyRuntimeContext } = resolveTranscriptPolicy({
        modelApi: api,
        runtimeHandle: {
          provider: "fixture",
          plugin: {
            id: "fixture",
            label: "Fixture",
            auth: [],
            ...(override === undefined
              ? {}
              : { buildReplayPolicy: () => ({ appendOnlyRuntimeContext: override }) }),
          },
        },
      });
      await withOpenClawTestState({ label: "runtime-context-persistence" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:runtime-context-persistence",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        };
        await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
        const settingsManager = SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
        });
        const requests: Context["messages"][] = [];
        streamMocks.streamSimple.mockImplementation((model, context) => {
          requests.push(structuredClone(context.messages));
          return createAssistantResultStream(
            requests.length === 1
              ? { ...createAssistant(model, [], "error"), errorMessage: "503 overloaded" }
              : createAssistant(model, [{ type: "text", text: "done" }]),
          );
        });
        const createPersistedSession = async () => {
          const sessionManager = guardSessionManager(
            SessionManager.open(target, state.workspaceDir),
          );
          const { session } = await createTestSession({ sessionManager, settingsManager });
          await prepareEmbeddedAttemptSessionBoundary({
            activeSession: session,
            appendOnlyRuntimeContext,
            attempt: {
              sessionId,
              prompt: "",
              config: { agents: { defaults: { userTimezone: "UTC" } } },
            },
            getUserTranscriptContexts: () => undefined,
            isRawModelRun: false,
            preparedUserTurnMessage: undefined,
            sessionManager,
            setActiveSessionSystemPrompt: vi.fn(),
          });
          return { session, sessionManager };
        };
        const first = await createPersistedSession();
        if (retained) {
          await first.session.sendCustomMessage(
            { customType: "test.extension-context", content: "extension context", display: false },
            { deliverAs: "nextTurn" },
          );
        }
        const submit = async (
          { session, sessionManager }: typeof first,
          text: string,
          runtimeOnly = false,
        ) => {
          const input = createBaseInput();
          await submitEmbeddedAttemptPrompt({
            ...input,
            activeSession: session,
            appendOnlyRuntimeContext,
            runtimeOnly,
            setNextUserMessagePersistence: sessionManager.setNextUserMessagePersistence,
            appendContext: undefined,
            prependContext: undefined,
            transcriptPrompt: text,
            modelPrompt: text,
            runtimeContextMessage: buildRuntimeContextCustomMessage(`context for ${text}`),
            promptActiveSession: (prompt, options) =>
              session.prompt(prompt, { ...options, expandPromptTemplates: false }),
          });
        };
        await submit(first, RUNTIME_EVENT_USER_PROMPT, true);
        expect(requests).toHaveLength(2);
        expect(requests[1]).toEqual(requests[0]);
        expect(requests[0]).toContainEqual(
          expect.objectContaining({
            role: "user",
            content: expect.stringMatching(/^\[.+\] Continue the OpenClaw runtime event\.$/),
          }),
        );
        first.session.dispose();

        const reopened = await createPersistedSession();
        await submit(reopened, "second");
        expect(requests).toHaveLength(3);
        if (retained) {
          // Boundary timestamp text and content before retained responses must replay byte-for-byte.
          const providerPrefix = (messages: Context["messages"]) =>
            JSON.stringify(messages.map(({ role, content }) => ({ role, content })));
          expect(providerPrefix(requests[2]!.slice(0, requests[0]!.length))).toBe(
            providerPrefix(requests[0]!),
          );
        }
        const entries = reopened.sessionManager.getEntries();
        const users = entries.flatMap((entry) =>
          entry.type === "message" && entry.message.role === "user" ? [entry.message] : [],
        );
        expect(users).toMatchObject([
          {
            content: [{ type: "text", text: RUNTIME_EVENT_USER_PROMPT }],
            display: false,
            provenance: { kind: "internal_system" },
          },
          { content: [{ type: "text", text: "second" }] },
        ]);
        expect(users[1]).not.toHaveProperty("display", false);
        expect(users[1]).not.toHaveProperty("provenance");
        const carriers = entries.filter(
          (entry) =>
            entry.type === "custom_message" && entry.customType === "openclaw.runtime-context",
        );
        expect(carriers).toHaveLength(retained ? 2 : 0);
        if (retained) {
          for (const carrier of carriers) {
            expect(carrier).toMatchObject({ display: false });
            const previous = entries[entries.indexOf(carrier) - 1];
            expect(previous).toMatchObject({ type: "message", message: { role: "user" } });
          }
          expect(requests[0]![1]).toMatchObject({ role: "user", runtimeContext: {} });
        } else {
          expect(JSON.stringify(requests[2])).not.toContain(
            `context for ${RUNTIME_EVENT_USER_PROMPT}`,
          );
        }

        reopened.sessionManager.appendResetBoundary("new");
        const reset = await createPersistedSession();
        await submit(reset, "after reset");
        expect(JSON.stringify(requests.at(-1))).not.toContain(RUNTIME_EVENT_USER_PROMPT);
        expect(JSON.stringify(requests.at(-1))).not.toContain("context for second");
        expect(JSON.stringify(requests.at(-1))).toContain("context for after reset");
      });
    },
  );
});
