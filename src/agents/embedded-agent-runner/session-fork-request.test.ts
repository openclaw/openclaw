import { expect, it } from "vitest";
import { applySessionForkRequest } from "./session-fork-request.js";

it.each([
  ["ollama", { type: "function", name: "exec" }, undefined],
  ["ollama", { type: "google_search" }, "cannot disable provider-hosted tools"],
  ["anthropic-messages", { type: "web_search_20250305", name: "web_search" }, undefined],
] as const)("disables %s tools %j in a tool-free fork", (api, tool, failure) => {
  const payload = { tools: [tool], tool_choice: "auto" };
  const apply = () => applySessionForkRequest(payload, { api, allowedTools: [] });
  if (failure) {
    expect(apply).toThrow(failure);
    return;
  }
  apply();
  expect(payload.tool_choice).toEqual(api === "anthropic-messages" ? { type: "none" } : "auto");
});
