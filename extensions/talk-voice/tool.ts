import { callGatewayTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";

export const executeTalkVoiceTool: AnyAgentTool["execute"] = async (_id, args, signal) => {
  const params = asOptionalRecord(args) ?? {};
  const action = readStringParam(params, "action", { required: true });
  let method: string;
  let request: Record<string, string>;
  switch (action) {
    case "list":
      method = "talk.voice.get";
      request = {};
      break;
    case "set":
      method = "talk.voice.set";
      request = { voice: readStringParam(params, "voice", { required: true }) };
      break;
    default:
      throw new Error(`Unknown Talk voice action: ${action}`);
  }
  return jsonResult(
    await callGatewayTool(method, { timeoutMs: 65_000 }, request, {
      requireAgentRuntimeIdentity: true,
      signal,
    }),
  );
};
