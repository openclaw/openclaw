import { expect, it } from "vitest";
import { respond, userInputs } from "./server.fixtures.test-support.js";
import {
  createMockServerTestHarness,
  outputItems,
  outputText,
  outputToolArgsFromItem,
  outputToolCall,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

it.each(["kickoff", "resumed"])(
  "preserves fanout synthesis in the %s native session when history quotes its kickoff",
  async (sessionId) => {
    const server = await startMockServer();
    const prompt =
      "Subagent fanout synthesis check: delegate two bounded subagents sequentially; each should reply exactly `ok`.";
    const tools = [{ type: "function", name: "sessions_spawn" }];
    const client_metadata = { session_id: "kickoff" };
    const first = await respond(server, prompt, { tools, client_metadata });
    expect(outputToolArgsFromItem(outputToolCall(first, "sessions_spawn"))).toMatchObject({
      label: "qa-fanout-alpha",
    });
    const second = await respond(
      server,
      userInputs(prompt, {
        type: "function_call_output",
        output:
          '{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha","note":"ALPHA-OK"}',
      }),
      { tools, client_metadata },
    );
    expect(outputToolArgsFromItem(outputToolCall(second, "sessions_spawn"))).toMatchObject({
      label: "qa-fanout-beta",
    });

    const marker = "Reply with exact marker: `NEW-MARKER`";
    const markerBeforeSettle = await respond(server, userInputs(prompt, marker), {
      tools: [{ type: "function", name: "sessions_yield" }],
      client_metadata,
    });
    expect(outputItems(markerBeforeSettle)).not.toContainEqual(
      expect.objectContaining({ type: "function_call" }),
    );
    expect(outputText(markerBeforeSettle)).toBe("NEW-MARKER");

    const wake = await respond(
      server,
      `<conversation_context>\n[user]\n${prompt}\n[assistant]\nThe child marker will arrive in its result.\n</conversation_context>\n\nCurrent user request:\n[Subagent Context] Every subagent in this batch has now settled.\nALPHA-OK\nBETA-OK`,
      { tools: [], client_metadata: { session_id: sessionId } },
    );
    expect(outputItems(wake)).not.toContainEqual(
      expect.objectContaining({ type: "function_call" }),
    );
    expect(outputText(wake)).toBe("subagent-1: ok\nsubagent-2: ok");
    const markerAfterSettle = await respond(server, userInputs(prompt, marker), {
      tools,
      client_metadata: { session_id: sessionId },
    });
    expect(outputItems(markerAfterSettle)).not.toContainEqual(
      expect.objectContaining({ type: "function_call" }),
    );
    expect(outputText(markerAfterSettle)).toBe("NEW-MARKER");
  },
);
