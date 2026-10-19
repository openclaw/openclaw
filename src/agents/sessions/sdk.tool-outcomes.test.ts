import { Type } from "typebox";
import { afterEach, assert, expect, it } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import { toToolDefinitions } from "../agent-tool-definition-adapter.js";
import type { AgentTool, AgentMessage } from "../runtime/index.js";
import { attachInternalToolExecutionPreparer } from "../runtime/internal-hooks.js";
import {
  createAssistant,
  createAssistantResultStream,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { AuthStorage } from "./auth-storage.js";
import type { MessageEndEvent, ToolResultEvent } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import { createAgentSession } from "./sdk.js";
import { withSessionState } from "./session-manager-fixtures.test-support.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

afterEach(resetSecretRedactionRegistryForTest);

it.each([false, true])(
  "preserves tool outcomes through events, replay, and storage (recovery=%s)",
  async (withRecovery) => {
    await withSessionState("tool-outcomes", async ({ state, scope: target }) => {
      const secret = "fixture-final-tool-outcome-credential";
      const image = {
        type: "image" as const,
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1sAAAAASUVORK5CYII=",
      };
      registerSecretValueForRedaction(secret);
      // Binary blocks must remain byte-exact even when their bytes match registered text.
      registerSecretValueForRedaction(image.data);
      const outcomes = [
        {
          name: "returned_error",
          details: { status: "error", error: "capture failed" },
          isError: true,
        },
        { name: "adapted_error", details: {}, throws: true, isError: true },
        { name: "preflight_error", details: {}, preflight: true, isError: true },
        { name: "recovered_tool", details: {}, throws: true, isError: !withRecovery },
        { name: "middleware_error", details: {}, isError: withRecovery },
        {
          name: "completed_command",
          details: { status: "completed", exitCode: 1 },
          isError: false,
        },
        { name: "successful_tool", details: { status: "ok" }, isError: false },
      ];
      const allOutcomes = [...outcomes, { name: "missing_tool", isError: true }];
      const calls = allOutcomes.map((outcome) => ({
        type: "toolCall" as const,
        id: `call_${outcome.name}`,
        name: outcome.name,
        arguments: {},
      }));
      const expected = allOutcomes.map(({ name, isError }) => ({ toolName: name, isError }));
      const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();
      if (withRecovery) {
        handlers.set("tool_result", [
          async (event) => {
            const { toolName } = event as ToolResultEvent;
            if (toolName === "recovered_tool") {
              return { isError: false };
            }
            if (toolName === "middleware_error") {
              return {
                content: [{ type: "text", text: `middleware failed ${secret}` }],
                details: { status: "error", error: "middleware failed" },
              };
            }
            return undefined;
          },
        ]);
        handlers.set("message_end", [
          async (event) => {
            const { message } = event as MessageEndEvent;
            if (message.role !== "toolResult" || message.toolName !== "successful_tool") {
              return undefined;
            }
            const content = message.content.map((block) =>
              block.type === "text"
                ? Object.assign({}, block, { text: `message-end rewrite ${secret}` })
                : block,
            );
            return { message: { ...message, content } };
          },
        ]);
      }
      const { session } = await createAgentSession({
        systemPrompt: "Test session prompt",
        sessionManager: await SessionManager.openAsync(target, state.agentDir("main")),
        model: testModel,
        thinkingLevel: "medium" as const,
        tools: outcomes.map((tool) => tool.name),
        customTools: toToolDefinitions(
          outcomes.map((outcome) => {
            const tool: AgentTool = {
              name: outcome.name,
              label: outcome.name,
              description: "Returns a synthetic tool outcome.",
              parameters: Type.Object({}),
              execute: async () => {
                if (outcome.throws) {
                  throw new Error(`capture failed: ${secret}`);
                }
                return {
                  content: [
                    { type: "text", text: `synthetic result ${secret}` },
                    ...(outcome.name === "successful_tool" ? [image] : []),
                  ],
                  details: outcome.details,
                };
              },
            };
            return outcome.preflight
              ? attachInternalToolExecutionPreparer(tool, async () => {
                  throw new Error(`preflight failed: ${secret}`);
                })
              : tool;
          }),
        ),
        resourceLoader: createResourceLoader(handlers),
        settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
        modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
      });
      const completed: Array<{ toolName: string; isError: boolean }> = [];
      session.subscribe((event) => {
        if (event.type === "tool_execution_end") {
          completed.push({ toolName: event.toolName, isError: event.isError });
        }
      });
      let replay: Extract<AgentMessage, { role: "toolResult" }>[] = [];
      let firstTurn = true;
      session.agent.streamFn = (_model, context) => {
        if (!firstTurn) {
          replay = context.messages.filter((message) => message.role === "toolResult");
          return createAssistantResultStream(createAssistant(testModel, "done"));
        }
        firstTurn = false;
        return createAssistantResultStream(createAssistant(testModel, calls, "toolUse"));
      };
      try {
        await session.agent.prompt(makeUserMessage("Run the synthetic tools.", 1));
        expect(completed).toHaveLength(expected.length);
        expect(completed).toEqual(expect.arrayContaining(expected));
        expect(replay).toMatchObject(expected);
        const text = replay
          .flatMap((message) =>
            message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
          )
          .join("\n");
        expect(text.includes("synthetic result")).toBe(true);
        expect(text.includes("message-end rewrite")).toBe(withRecovery);
        expect(text).toContain(secret);
        expect(replay.flatMap((message) => message.content)).toContainEqual(
          expect.objectContaining({ type: "image", data: image.data }),
        );
        const persistedTarget = session.sessionManager.getSessionTarget();
        assert(persistedTarget, "Expected a saved transcript target");
        const events = SessionManager.open(persistedTarget).getEntries();
        expect(
          events.flatMap((event) =>
            event.type === "message" && event.message.role === "toolResult" ? [event.message] : [],
          ),
        ).toMatchObject(expected);
      } finally {
        session.dispose();
      }
    });
  },
);
