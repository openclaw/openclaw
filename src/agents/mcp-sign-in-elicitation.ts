import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import type { OperatorMcpConnectContext } from "./agent-bundle-mcp-operator-connect.js";
import { runWithMcpUrlPresenter } from "./mcp-client-elicitation.js";
import { setMcpCodeModeGuestResultFromAgentResult } from "./mcp-content.js";
import type { AgentToolResult } from "./runtime/index.js";
import type { AnyAgentTool } from "./tools/common.js";

function buildSignInResult(serverName: string, url: string): AgentToolResult<unknown> {
  return setMcpCodeModeGuestResultFromAgentResult({
    content: [
      {
        type: "text",
        text:
          `MCP server "${serverName}" needs the user to sign in at ${new URL(url).host}. ` +
          `Your reply shows a Connect ${serverName} button for it. Ask the user to sign in, then try again.`,
      },
    ],
    details: { mcpServer: serverName, mcpConnect: { serverName, authorizationUrl: url } },
  });
}

/** Wraps MCP tool calls in place so their plugin metadata stays attached. */
export function withMcpSignInCards(
  tools: AnyAgentTool[],
  turn: OperatorMcpConnectContext | undefined,
): AnyAgentTool[] {
  for (const tool of tools) {
    const mcp = getPluginToolMeta(tool)?.mcp;
    if (mcp?.operation === "tool") {
      tool.execute = withMcpSignInCard(mcp.serverName, turn, tool.execute);
    }
  }
  return tools;
}

/**
 * A server's URL sign-in request (elicitation or -32042) becomes the reply's Connect
 * card, only for the owner in an untainted direct chat. The address never enters model text.
 */
function withMcpSignInCard(
  serverName: string,
  turn: OperatorMcpConnectContext | undefined,
  execute: AnyAgentTool["execute"],
): AnyAgentTool["execute"] {
  return async (...args) => {
    let url: string | undefined;
    const present = (requested: string) => {
      if (
        turn?.senderIsOwner === true &&
        turn.chatType === "direct" &&
        turn.isTurnTainted?.() === false
      ) {
        url = requested;
      }
    };
    try {
      const result = await runWithMcpUrlPresenter(present, () => execute(...args));
      return url ? buildSignInResult(serverName, url) : result;
    } catch (error) {
      const [{ UrlElicitationRequiredError }, { compileStructuredInputUrl }] = await Promise.all([
        import("@modelcontextprotocol/client"),
        import("./harness/structured-input.js"),
      ]);
      const request =
        error instanceof UrlElicitationRequiredError ? error.elicitations[0] : undefined;
      const input = request
        ? compileStructuredInputUrl({
            ...request,
            fallbackMessage: "MCP server needs sign-in",
            protocolName: "MCP",
          })
        : undefined;
      if (input?.kind === "ready" && input.plan.kind === "url" && input.plan.question.url) {
        present(input.plan.question.url);
      }
      if (!url) {
        throw error;
      }
      return buildSignInResult(serverName, url);
    }
  };
}
