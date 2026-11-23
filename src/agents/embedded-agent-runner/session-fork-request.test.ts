import { expect, it } from "vitest";
import { applySessionForkRequest } from "./session-fork-request.js";

const responses = { api: "openai-responses" as const, allowedTools: [] };
const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
const call = (id: string) => ({ type: "function_call", call_id: id, name: "lookup" });
const output = (id: string) => ({ type: "function_call_output", call_id: id, output: "1" });

it("sends the parent's request, then only the fork's own items, in the parent's ID spelling", () => {
  const parent = {
    model: "m",
    instructions: "Stable instructions",
    tools: [{ type: "function", name: "lookup" }],
    reasoning: { effort: "high" },
    input: [user("Parent question"), user("Runtime note"), call("call_sent"), output("call_sent")],
  };
  // Rebuilt history orders the note first and keeps the ID the parent's stream rewrote.
  const payload: Record<string, unknown> = {
    model: "m",
    instructions: "Rebuilt instructions",
    input: [
      user("Runtime note"),
      user("Parent question"),
      call("call_raw"),
      output("call_raw"),
      user("Review only"),
    ],
  };
  applySessionForkRequest(payload, { preparedRequest: parent, ownOutputLimit: false }, responses);
  expect(payload).toEqual({
    ...parent,
    input: [...parent.input, user("Review only")],
    tool_choice: "none",
  });
});

it("keeps the fork's own transport handles and rebuilt continuation requests", () => {
  const signal = new AbortController().signal;
  const contents = [{ role: "model", parts: [{ functionCall: { args: { value: null } } }] }];
  const payload = { contents: [...contents], config: { abortSignal: signal } };
  const preparedRequest = { contents, config: { abortSignal: AbortSignal.abort(), top_k: 4 } };
  applySessionForkRequest(
    payload,
    { preparedRequest, ownOutputLimit: false },
    { api: "google-generative-ai", allowedTools: [] },
  );
  expect(payload).toEqual({ contents, config: { abortSignal: signal, top_k: 4 } });
  expect(payload.config.abortSignal).toBe(signal);

  // A continuation carries only its delta; the fork sends its full rebuilt history instead.
  const rebuilt = { input: [user("Parent question"), user("Review only")] };
  applySessionForkRequest(
    rebuilt,
    {
      preparedRequest: { previous_response_id: "resp_1", input: [user("Continue")] },
      ownOutputLimit: false,
    },
    responses,
  );
  expect(rebuilt).toEqual({ input: [user("Parent question"), user("Review only")] });
});

it.each([
  ["ollama", { type: "function", name: "exec" }, undefined],
  ["ollama", { type: "google_search" }, "cannot disable provider-hosted tools"],
  ["anthropic-messages", { type: "web_search_20250305", name: "web_search" }, undefined],
] as const)("disables %s tools %j in a tool-free fork", (api, tool, failure) => {
  const payload = { tools: [tool], tool_choice: "auto" };
  const apply = () =>
    applySessionForkRequest(payload, { ownOutputLimit: false }, { api, allowedTools: [] });
  if (failure) {
    expect(apply).toThrow(failure);
    return;
  }
  apply();
  expect(payload.tool_choice).toEqual(api === "anthropic-messages" ? { type: "none" } : "auto");
});

it("replays for a fork that runs tools only when the parent lists them", () => {
  const own = { input: [user("Q"), user("Review")], max_output_tokens: 512 };
  const parent = (tools: unknown[]) => ({
    tools,
    max_output_tokens: 32_000,
    input: [user("Q")],
  });
  const fork = (tools: unknown[], ownOutputLimit = false) => {
    const payload = structuredClone(own);
    applySessionForkRequest(
      payload,
      { preparedRequest: parent(tools), ownOutputLimit },
      { api: "openai-responses", allowedTools: ["note"] },
    );
    return payload;
  };
  const note = { type: "function", name: "note" };
  expect(fork([note])).toEqual({ ...parent([note]), input: own.input });
  // The caller's own output limit survives the replay.
  expect(fork([note], true)).toMatchObject({ tools: [note], max_output_tokens: 512 });
  // A hosted tool stays listed with the parent's bytes; a fork that runs tools may use it.
  const search = { type: "web_search" };
  expect(fork([note, search])).toEqual({ ...parent([note, search]), input: own.input });
  // The parent never listed the fork's tool.
  expect(fork([{ type: "function", name: "other" }])).toEqual(own);
});
