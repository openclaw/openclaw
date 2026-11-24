import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
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
          "The user sees a sign-in button for it. Ask the user to sign in, then try again.",
      },
    ],
    details: {
      status: "error",
      mcpServer: serverName,
      mcpConnect: { serverName, authorizationUrl: url },
    },
  });
}

/**
 * A server's URL sign-in request (elicitation or -32042) becomes the reply's Connect
 * card, only for the owner in an untainted direct chat. The address never enters model text.
 * Tools are wrapped in place so their plugin metadata stays attached.
 */
export function withMcpSignInCards(
  tools: AnyAgentTool[],
  canOfferSignIn: () => boolean,
): AnyAgentTool[] {
  for (const tool of tools) {
    const mcp = getPluginToolMeta(tool)?.mcp;
    if (mcp?.operation !== "tool") {
      continue;
    }
    const { execute } = tool;
    tool.execute = async (...args) => {
      let url: string | undefined;
      const present = (requested: string) => {
        if (canOfferSignIn()) {
          url = requested;
        }
      };
      try {
        const result = await runWithMcpUrlPresenter(present, () => execute(...args));
        if (url && canOfferSignIn()) {
          result.details = {
            ...asOptionalRecord(result.details),
            mcpConnect: { serverName: mcp.serverName, authorizationUrl: url },
          };
        }
        return result;
      } catch (error) {
        const [{ UrlElicitationRequiredError }, { compileStructuredInputUrl }] = await Promise.all([
          import("@modelcontextprotocol/client"),
          import("./harness/structured-input.js"),
        ]);
        const request =
          error instanceof UrlElicitationRequiredError ? error.elicitations[0] : undefined;
        if (!request) {
          throw error;
        }
        const input = compileStructuredInputUrl({
          ...request,
          fallbackMessage: "MCP server needs sign-in",
          protocolName: "MCP",
        });
        const signInUrl =
          input.kind === "ready" && input.plan.kind === "url" ? input.plan.question.url : undefined;
        if (!signInUrl || !canOfferSignIn()) {
          throw error;
        }
        return buildSignInResult(mcp.serverName, signInUrl);
      }
    };
  }
  return tools;
}
