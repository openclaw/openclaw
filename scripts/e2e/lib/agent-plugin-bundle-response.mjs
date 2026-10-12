import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../../lib/record-shared.mjs";
import { readMockUserText } from "./mock-inference-facts.ts";

const targetName = "weather-probe__weather_probe";
const controls = ["tool_search", "tool_describe", "tool_call"];

function failure(reason) {
  return { text: `AGENT_BUNDLE_MCP_FAIL ${reason}` };
}

function readJson(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readToolOutput(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  // MCP metadata and results use the normal API-content boundary on the model wire.
  const framed = value.match(
    /(?:^|\n)<<<EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>\nSource: API\n---\n([\s\S]*)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>$/u,
  );
  return framed ? readJson(framed[2]) : undefined;
}

function isTarget(value) {
  return (
    isRecord(value) &&
    value.name === targetName &&
    value.source === "mcp" &&
    typeof value.id === "string" &&
    value.id.length > 0
  );
}

export function resolveAgentPluginBundleResponse(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  if (
    !controls.every((name) => tools.some((tool) => tool?.type === "function" && tool.name === name))
  ) {
    return failure("tool-not-declared");
  }
  const input = Array.isArray(body?.input) ? body.input : [];
  const turn = input.slice(input.findLastIndex((item) => readMockUserText(item) !== undefined) + 1);
  const events = turn.filter(
    (item) => item?.type === "function_call" || item?.type === "function_call_output",
  );
  if (events.length > 6 || events.length % 2 !== 0) {
    return failure("unexpected-tool-output");
  }
  const rounds = [];
  const callIds = new Set();
  for (let index = 0; index < events.length; index += 2) {
    const call = events[index];
    const output = events[index + 1];
    if (
      call.type !== "function_call" ||
      output.type !== "function_call_output" ||
      typeof call.call_id !== "string" ||
      !call.call_id ||
      callIds.has(call.call_id) ||
      output.call_id !== call.call_id ||
      output.isError === true
    ) {
      return failure("unexpected-tool-output");
    }
    callIds.add(call.call_id);
    rounds.push({
      name: call.name,
      args: readJson(call.arguments),
      value: readToolOutput(output.output),
    });
  }
  if (rounds.length === 0) {
    return { tool: { name: "tool_search", args: { query: targetName, limit: 1 } } };
  }
  const search = rounds[0];
  const candidates = Array.isArray(search.value) ? search.value : [];
  if (
    search.name !== "tool_search" ||
    search.args?.query !== targetName ||
    candidates.length !== 1 ||
    !isTarget(candidates[0])
  ) {
    return failure("unexpected-tool-output");
  }
  const target = candidates[0];
  if (rounds.length === 1) {
    return { tool: { name: "tool_describe", args: { id: target.id } } };
  }
  const description = rounds[1];
  if (
    description.name !== "tool_describe" ||
    description.args?.id !== target.id ||
    !isTarget(description.value) ||
    description.value.id !== target.id ||
    !isDeepStrictEqual(description.value.parameters, {
      type: "object",
      properties: {},
      additionalProperties: false,
    })
  ) {
    return failure("unexpected-tool-output");
  }
  if (rounds.length === 2) {
    return { tool: { name: "tool_call", args: { id: target.id, args: {} } } };
  }
  const call = rounds[2];
  const result = call.value?.result;
  if (
    call.name !== "tool_call" ||
    call.args?.id !== target.id ||
    !isRecord(call.args.args) ||
    Object.keys(call.args.args).length !== 0 ||
    !isTarget(call.value?.tool) ||
    call.value.tool.id !== target.id ||
    !isRecord(result) ||
    result.isError === true ||
    !Array.isArray(result.content) ||
    !isRecord(result.details) ||
    result.details.mcpServer !== "weather-probe" ||
    result.details.mcpTool !== "weather_probe" ||
    result.details.status !== undefined ||
    result.details.error !== undefined
  ) {
    return failure("unexpected-tool-output");
  }
  const text = result.content
    .flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n");
  return /^probe ok; PLUGIN_ROOT=[\s\S]+; PLUGIN_DATA=[\s\S]+; PROBE_MODE=live$/u.exec(
    text,
  )?.[0] === text
    ? { text: "AGENT_BUNDLE_MCP_OK" }
    : failure("unexpected-tool-output");
}
