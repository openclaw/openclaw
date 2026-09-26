import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { PluginHookRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import qaLabPlugin from "../../../index.js";
import { QA_SESSION_OBSERVER_HEADER } from "../shared/session-observer-registry.js";
import {
  type MockServer,
  createMockServerTestHarness,
  expectNonStreamingResponsesJson,
  expectOk,
  getJson,
  makeToolOutputWithCallId,
  makeUserInput,
  outputText,
  outputToolArgsFromItem,
  outputToolCall,
  postJson,
  requireRecord,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();
const prefix = "qa-session-" + "a".repeat(53);

async function observeSession(server: MockServer, sessionId: string) {
  let gate: PluginHookRegistration<"before_agent_run">["handler"] | undefined;
  qaLabPlugin.register(
    createTestPluginApi({
      config: {
        models: {
          providers: {
            "mock-openai": {
              baseUrl: `${server.baseUrl}/v1`,
              models: [],
              request: {
                headers: { [QA_SESSION_OBSERVER_HEADER]: `${server.baseUrl}/debug/session` },
              },
            },
          },
        },
      },
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
  expect(
    await gate({ prompt: "No session identity in the prompt", messages: [] }, { sessionId }),
  ).toBeUndefined();
}

describe("QA transport session identity", () => {
  it("isolates interleaved sessions across providers and cache boundaries without prompt identity", async () => {
    const sessions = [
      "qa-session-alpha-" + "a".repeat(80),
      "qa-session-beta-" + "b".repeat(80),
    ] as const;
    const server = await startMockServer();
    for (const sessionId of sessions) {
      await observeSession(server, sessionId);
    }
    const handoffPrompt =
      "Delegate one bounded QA task to a subagent. Wait for the subagent to finish.";
    const fanoutPrompt =
      "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";
    const postSession = async (sessionId: string, input: unknown[], cacheBoundary = 0) =>
      (
        await expectOk(
          postJson(
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
          ),
        )
      ).json();
    const postAnthropic = async (sessionId: string) =>
      (
        await expectOk(
          postJson(
            server,
            "/v1/messages",
            {
              tools: [{ name: "sessions_spawn", input_schema: { type: "object", properties: {} } }],
              messages: [{ role: "user", content: [{ type: "text", text: handoffPrompt }] }],
            },
            { "x-session-affinity": sessionId },
          ),
        )
      ).json();
    const handoffs = await Promise.all(
      sessions.map((id) => postSession(id, [makeUserInput(handoffPrompt)])),
    );
    for (const handoff of handoffs) {
      expect(outputToolArgsFromItem(outputToolCall(handoff, "sessions_spawn"))).toMatchObject({
        label: "qa-sidecar",
      });
    }
    expect(
      requireRecord(await postAnthropic(sessions[0]), "cross-provider continuation").stop_reason,
    ).toBe("end_turn");
    expect(
      requireRecord(await postAnthropic("qa-session-anthropic"), "independent Anthropic handoff")
        .stop_reason,
    ).toBe("tool_use");
    for (const [boundary, label] of [
      [1, "qa-fanout-alpha"],
      [2, "qa-fanout-beta"],
    ] as const) {
      const calls = await Promise.all(
        sessions.map((id) =>
          postSession(
            id,
            [
              makeUserInput(fanoutPrompt),
              ...(boundary === 2
                ? [
                    makeToolOutputWithCallId(
                      "spawn",
                      '{"status":"accepted","childSessionKey":"alpha","note":"ALPHA-OK"}',
                    ),
                  ]
                : []),
            ],
            boundary,
          ),
        ),
      );
      for (const call of calls) {
        expect(outputToolArgsFromItem(outputToolCall(call, "sessions_spawn"))).toMatchObject({
          label,
        });
      }
    }
  });

  it.each([
    "You are a JSON-only function. Return only a valid JSON value.",
    "You are keeping a dream diary. Write a single entry in first person.",
    "Choose how to incorporate each supplied candidate into MEMORY.md.",
  ])("accepts standalone tool-free completion: %s", async (instructions) => {
    const server = await startMockServer();
    await observeSession(server, "observed-agent-session");
    const response = await postJson(server, "/v1/responses", {
      instructions,
      input: [makeUserInput("Reply exactly: {}")],
      tools: [],
    });
    expect(response.status).toBe(200);
    expect(outputText(await response.json())).toBe("{}");
    expect(await getJson(server, "/debug/last-request")).toMatchObject({
      requestKind: "agent-initial",
      prompt: "Reply exactly: {}",
    });
  });

  it.each([
    { input: [makeUserInput("You are a JSON-only function.")], tools: [] },
    {
      instructions: "You are a JSON-only function.",
      input: [makeUserInput("Reply exactly: {}")],
      tools: [{ type: "function", name: "read" }],
    },
  ])("requires affinity for quoted or tool-enabled utility prompts", async (body) => {
    const server = await startMockServer();
    await observeSession(server, "observed-agent-session");
    const response = await postJson(server, "/v1/responses", body);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("Missing QA session identity");
  });

  it.each([
    { type: "function_call_output", output: "tool result", beforeUser: false },
    { type: "custom_tool_call_output", output: "", beforeUser: false },
    { type: "function_call_output", output: "earlier result", beforeUser: true },
  ])(
    "requires affinity for utility requests carrying $type (earlier=$beforeUser)",
    async ({ type, output, beforeUser }) => {
      const server = await startMockServer();
      await observeSession(server, "observed-agent-session");
      const user = makeUserInput("Reply exactly: {}");
      const result = { type, call_id: "utility-continuation", output };
      const body = {
        instructions: "You are a JSON-only function. Return only a valid JSON value.",
        tools: [],
        input: beforeUser ? [result, user] : [user, result],
      };
      const missing = await postJson(server, "/v1/responses", body);
      expect(missing.status).toBe(500);
      expect(await missing.text()).toContain("Missing QA session identity");
      const admitted = await postJson(server, "/v1/responses", body, {
        session_id: "observed-agent-session",
      });
      expect(admitted.status).toBe(200);
    },
  );

  it("settles the full requester observed behind a truncated affinity value", async () => {
    const sessionId = `internal-session-effects-${"run-".repeat(20)}parent`;
    const childSessionKey = "agent:qa:subagent:identity-child";
    const session = {
      key: "agent:qa:main",
      agentId: "qa",
      sessionId,
      hasActiveRun: false,
      status: "done",
      abortedLastRun: false,
    };
    const gateway = { call: async () => ({ sessions: [session], nextOffset: null }) };
    const server = await startMockServer();
    await observeSession(server, sessionId);
    const response = await expectOk(
      postJson(
        server,
        "/v1/responses",
        {
          instructions: "Runtime: embedded | agent=qa | session=agent:qa:main",
          input: [
            makeUserInput("Subagent terminal reply QA check: visible."),
            { type: "function_call", call_id: "spawn", name: "sessions_spawn", arguments: "{}" },
            makeToolOutputWithCallId(
              "spawn",
              JSON.stringify({ status: "accepted", childSessionKey, runId: "identity-run" }),
            ),
          ],
        },
        { session_id: sessionId.slice(0, 64) },
      ),
    );
    expect(outputText(await response.json())).toBe("Worker started.");
    expect(await getJson(server, "/debug/last-request")).toMatchObject({ sessionId });
    await server.terminalRequesters.settle(gateway);
    const child = await expectNonStreamingResponsesJson(server, {
      client_metadata: { session_id: "identity-child" },
      instructions: `- Your session: ${childSessionKey}.`,
      input: [makeUserInput("Subagent terminal reply QA worker: visible.")],
    });
    expect(outputText(child)).toBe("QA-SUBAGENT-TERMINAL-VISIBLE-OK");
  });

  it("prefers an observed exact identity even when longer identities share its prefix", async () => {
    const server = await startMockServer();
    for (const sessionId of [prefix, `${prefix}-first`, `${prefix}-second`]) {
      await observeSession(server, sessionId);
    }
    await expectOk(
      postJson(
        server,
        "/v1/responses",
        { input: "Reply exactly: IDENTITY-OK" },
        { session_id: prefix },
      ),
    );
    expect(await getJson(server, "/debug/last-request")).toMatchObject({ sessionId: prefix });
  });

  it.each([
    {
      ids: [`${prefix}-first`, `${prefix}-second`],
      error: "Ambiguous QA session affinity",
      affinity: prefix,
    },
    { ids: [], error: "Unknown QA session affinity", affinity: prefix },
    {
      ids: [`${prefix}-first`, `${prefix}-second`],
      error: "Missing QA session identity",
      affinity: undefined,
    },
  ])(
    "rejects $error instead of assigning another session's state",
    async ({ ids, error, affinity }) => {
      const server = await startMockServer();
      for (const sessionId of ids) {
        await observeSession(server, sessionId);
      }
      const response = await postJson(
        server,
        "/v1/responses",
        { input: "Reply exactly: IDENTITY-OK" },
        affinity ? { session_id: affinity } : undefined,
      );
      expect(response.status).toBe(500);
      expect(await response.text()).toContain(error);
      expect(await getJson(server, "/debug/requests")).toEqual([]);
    },
  );
});
