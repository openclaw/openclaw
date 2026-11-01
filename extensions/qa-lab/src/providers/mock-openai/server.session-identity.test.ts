import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { PluginHookRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import qaLabPlugin from "../../../index.js";
import { QA_SESSION_OBSERVER_HEADER } from "../shared/session-observer-registry.js";
import { respond, settleParent, textBlock, userInputs } from "./server.fixtures.test-support.js";
import {
  type MockServer,
  createMockServerTestHarness,
  expectOk,
  makeAnthropicUserText,
  getJson,
  makeToolOutputWithCallId,
  outputText,
  outputToolArgsFromItem,
  outputToolCall,
  postJson,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();
const prefix = "qa-session-" + "a".repeat(53);

async function requestJson(
  server: MockServer,
  route: string,
  body: unknown,
  headers?: Record<string, string>,
) {
  return (await expectOk(postJson(server, route, body, headers))).json();
}

async function startObservedServer(...sessionIds: string[]) {
  const server = await startMockServer();
  const provider = {
    baseUrl: `${server.baseUrl}/v1`,
    models: [],
    request: { headers: { [QA_SESSION_OBSERVER_HEADER]: `${server.baseUrl}/debug/session` } },
  };
  let gate: PluginHookRegistration<"before_agent_run">["handler"] | undefined;
  qaLabPlugin.register(
    createTestPluginApi({
      config: { models: { providers: { "mock-openai": provider } } },
      on: (hookName, handler) => {
        if (hookName === "before_agent_run") {
          gate = handler as PluginHookRegistration<"before_agent_run">["handler"];
        }
      },
    }),
  );
  if (!gate) {
    throw new Error("QA session observation gate was not registered");
  }
  for (const sessionId of sessionIds) {
    await gate({ prompt: "No session identity in the prompt", messages: [] }, { sessionId });
  }
  return server;
}

function expectSpawnLabel(response: unknown, label: string) {
  expect(outputToolArgsFromItem(outputToolCall(response, "sessions_spawn"))).toMatchObject({
    label,
  });
}

describe("QA transport session identity", () => {
  it("isolates interleaved sessions across providers and cache boundaries without prompt identity", async () => {
    const sessions = [
      "qa-session-alpha-" + "a".repeat(80),
      "qa-session-beta-" + "b".repeat(80),
    ] as const;
    const server = await startObservedServer(...sessions);
    const handoffPrompt =
      "Delegate one bounded QA task to a subagent. Wait for the subagent to finish.";
    const fanoutPrompt =
      "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";
    const postSession = (sessionId: string, input: unknown[], cacheBoundary = 0) =>
      requestJson(
        server,
        "/v1/responses",
        {
          // Quoted legacy markers and cache keys are not conversation identities.
          instructions: "Runtime: agent=main | sessionId=quoted-session | channel=qa",
          prompt_cache_key: `unrelated-cache-key:${cacheBoundary}`,
          tools: [{ type: "function", name: "sessions_spawn" }],
          input,
        },
        { session_id: sessionId.slice(0, 64) },
      );
    const postAnthropic = (sessionId: string) =>
      requestJson(
        server,
        "/v1/messages",
        {
          tools: [{ name: "sessions_spawn", input_schema: { type: "object", properties: {} } }],
          messages: [makeAnthropicUserText(handoffPrompt)],
        },
        { "x-session-affinity": sessionId },
      );
    const handoffs = await Promise.all(
      sessions.map((id) => postSession(id, userInputs(handoffPrompt))),
    );
    for (const handoff of handoffs) {
      expectSpawnLabel(handoff, "qa-sidecar");
    }
    expect(await postAnthropic(sessions[0])).toMatchObject({ stop_reason: "end_turn" });
    expect(await postAnthropic("qa-session-anthropic")).toMatchObject({ stop_reason: "tool_use" });
    for (const [boundary, label] of [
      [1, "qa-fanout-alpha"],
      [2, "qa-fanout-beta"],
    ] as const) {
      const input = userInputs(fanoutPrompt);
      if (boundary === 2) {
        input.push(
          makeToolOutputWithCallId(
            "spawn",
            '{"status":"accepted","childSessionKey":"alpha","note":"ALPHA-OK"}',
          ),
        );
      }
      const calls = await Promise.all(sessions.map((id) => postSession(id, input, boundary)));
      for (const call of calls) {
        expectSpawnLabel(call, label);
      }
    }
  });

  it("accepts standalone tool-free completion", async () => {
    const instructions = "Choose how to incorporate each supplied candidate into MEMORY.md.";
    const server = await startObservedServer("observed-agent-session");
    for (const body of [
      { instructions, input: userInputs("Reply exactly: {}"), tools: [] },
      { instructions, input: "Reply exactly: {}" },
      ...["system", "developer"].map((role) => ({
        input: userInputs(
          { type: "message", role, content: [textBlock(instructions)] },
          "Reply exactly: {}",
        ),
      })),
    ]) {
      const response = await postJson(server, "/v1/responses", body);
      expect(response.status).toBe(200);
      expect(outputText(await response.json())).toBe("{}");
    }
    const anthropic = await postJson(server, "/v1/messages", {
      system: [{ type: "text", text: instructions }],
      messages: [makeAnthropicUserText("Reply exactly: {}")],
      tools: [],
    });
    expect(anthropic.status).toBe(200);
    expect(await anthropic.json()).toMatchObject({ content: [{ type: "text", text: "{}" }] });
  });

  it("requires utility affinity for Anthropic history discarded by normalization", async () => {
    const sessionId = "observed-agent-session";
    const server = await startObservedServer(sessionId);
    const request = {
      instructions: "You are a JSON-only function. Return only a valid JSON value.",
      input: userInputs("Reply exactly: {}"),
      tools: [],
      system: "You are a JSON-only function.",
      messages: [
        { role: "assistant", content: [{ type: "thinking", thinking: "Earlier reasoning" }] },
        { role: "user", content: "Reply exactly: {}" },
      ],
    };
    const missing = await postJson(server, "/v1/messages", request);
    expect(missing.status).toBe(500);
    expect(await missing.text()).toContain("Missing QA session identity");
    expect(await getJson(server, "/debug/requests")).toEqual([]);
    const admitted = await postJson(server, "/v1/messages", request, {
      "x-session-affinity": sessionId,
    });
    expect(admitted.status).toBe(200);
    expect(await getJson(server, "/debug/last-request")).toMatchObject({ sessionId });
  });

  it("settles the full requester observed behind a truncated affinity value", async () => {
    const sessionId = `internal-session-effects-${"run-".repeat(20)}parent`;
    const childSessionKey = "agent:qa:subagent:identity-child";
    const server = await startObservedServer(sessionId);
    const response = await requestJson(
      server,
      "/v1/responses",
      {
        instructions: "Runtime: embedded | agent=qa | session=agent:qa:main",
        input: userInputs(
          "Subagent terminal reply QA check: visible.",
          { type: "function_call", call_id: "spawn", name: "sessions_spawn", arguments: "{}" },
          makeToolOutputWithCallId(
            "spawn",
            JSON.stringify({ status: "accepted", childSessionKey, runId: "identity-run" }),
          ),
        ),
      },
      { session_id: sessionId.slice(0, 64) },
    );
    expect(outputText(response)).toBe("Worker started.");
    expect(await getJson(server, "/debug/last-request")).toMatchObject({ sessionId });
    await settleParent(server, sessionId);
    const child = await respond(server, "Subagent terminal reply QA worker: visible.", {
      client_metadata: { session_id: "identity-child" },
      instructions: `- Your session: ${childSessionKey}.`,
    });
    expect(outputText(child)).toBe("QA-SUBAGENT-TERMINAL-VISIBLE-OK");
  });

  it.each<[string, string[], string?]>([
    [
      "observed exact identity wins over longer prefixes",
      [prefix, `${prefix}-first`, `${prefix}-second`],
    ],
    ["ambiguous prefix", [`${prefix}-first`, `${prefix}-second`], "Ambiguous QA session affinity"],
    ["unknown prefix", [], "Unknown QA session affinity"],
  ])("resolves transport identity safely: %s", async (_name, ids, error) => {
    const server = await startObservedServer(...ids);
    const response = await postJson(
      server,
      "/v1/responses",
      { input: "Reply exactly: IDENTITY-OK" },
      { session_id: prefix },
    );
    if (error) {
      expect(response.status).toBe(500);
      expect(await response.text()).toContain(error);
      expect(await getJson(server, "/debug/requests")).toEqual([]);
    } else {
      expect(response.status).toBe(200);
      expect(await getJson(server, "/debug/last-request")).toMatchObject({ sessionId: prefix });
    }
  });
});
