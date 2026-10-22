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

async function requestJson(
  server: MockServer,
  route: string,
  body: unknown,
  headers?: Record<string, string>,
) {
  return (await expectOk(postJson(server, route, body, headers))).json();
}

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
          messages: [{ role: "user", content: [{ type: "text", text: handoffPrompt }] }],
        },
        { "x-session-affinity": sessionId },
      );
    const handoffs = await Promise.all(
      sessions.map((id) => postSession(id, userInputs(handoffPrompt))),
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

  it("accepts standalone tool-free completion", async () => {
    const instructions = "Choose how to incorporate each supplied candidate into MEMORY.md.";
    const server = await startMockServer();
    await observeSession(server, "observed-agent-session");
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
      expect(await getJson(server, "/debug/last-request")).toMatchObject({
        requestKind: "agent-initial",
        prompt: "Reply exactly: {}",
      });
    }
    const anthropic = await postJson(server, "/v1/messages", {
      system: [{ type: "text", text: instructions }],
      messages: [{ role: "user", content: [{ type: "text", text: "Reply exactly: {}" }] }],
      tools: [],
    });
    expect(anthropic.status).toBe(200);
    expect(await anthropic.json()).toMatchObject({ content: [{ type: "text", text: "{}" }] });
  });

  it("requires utility affinity for Anthropic history discarded by normalization", async () => {
    const route = "/v1/messages";

    const server = await startMockServer();
    const sessionId = "observed-agent-session";
    await observeSession(server, sessionId);
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
    const missing = await postJson(server, route, request);
    expect(missing.status).toBe(500);
    expect(await missing.text()).toContain("Missing QA session identity");
    expect(await getJson(server, "/debug/requests")).toEqual([]);
    const admitted = await postJson(server, route, request, { "x-session-affinity": sessionId });
    expect(admitted.status).toBe(200);
    expect(await getJson(server, "/debug/last-request")).toMatchObject({ sessionId });
  });

  it("settles the full requester observed behind a truncated affinity value", async () => {
    const sessionId = `internal-session-effects-${"run-".repeat(20)}parent`;
    const childSessionKey = "agent:qa:subagent:identity-child";
    const server = await startMockServer();
    await observeSession(server, sessionId);
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

  it.each([
    {
      name: "observed exact identity wins over longer prefixes",
      ids: [prefix, `${prefix}-first`, `${prefix}-second`],
      affinity: prefix,
    },
    {
      name: "ambiguous prefix",
      ids: [`${prefix}-first`, `${prefix}-second`],
      error: "Ambiguous QA session affinity",
      affinity: prefix,
    },
    { name: "unknown prefix", ids: [], error: "Unknown QA session affinity", affinity: prefix },
  ])("resolves transport identity safely: $name", async ({ ids, error, affinity }) => {
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
