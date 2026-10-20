/** Curated source IDs, verified against vendor docs and bundled skills; never match by display name. */
const EQUIVALENTS: Readonly<Record<string, { name: string; setup: string }>> = {
  "48668144": {
    name: "AgentMail",
    setup:
      "Install the official plugin with `openclaw plugins install clawhub:@agentmail/agentmail --no-enable`. Explicitly keep it disabled during setup with `openclaw plugins disable agentmail`; --no-enable preserves defaults rather than forcing a disabled state. Configure an AgentMail API key through native setup, then enable the plugin and use its bundled CLI skill for inbox creation and mail reads. An inbound email channel is not required for scheduled reads. Setup: https://www.agentmail.to/docs/integrations/openclaw",
  },
  "49086599": {
    name: "X reads/search via the bundled xurl skill",
    setup:
      "Set up the bundled xurl skill and its CLI prerequisite, then authorize the intended X account. Use xurl read/search for competitor monitoring; the X messaging channel does not provide this workflow. Setup: https://github.com/xdevplatform/xurl",
  },
  "45893410": {
    name: "Gmail via the bundled gog skill",
    setup:
      "Set up the bundled gog skill and its CLI prerequisite, then authorize the intended Google account for Gmail. Use its mail search/read commands. If Gmail is a fallback for AgentMail, configure only the chosen inbox provider. Setup: https://gogcli.sh",
  },
  "674": {
    name: "Slack delivery via the bundled Slack integration",
    setup:
      "Configure the bundled Slack integration with a Slack app and the intended destination channel. Preserve optional delivery: do not create inbound bindings or send a report merely to complete migration. Setup: https://docs.openclaw.ai/channels/slack",
  },
  "47725205": {
    name: "Salesforce read-only MCP (manual organization setup)",
    setup:
      "Salesforce's SObject Reads MCP supports record queries, but requires organization activation and compatible OAuth client setup before a native MCP connection can be used. Discover the organization's competitor/reason fields after authorization. URL-only login and tool parity are unverified; this remains manual. Setup: https://developer.salesforce.com/docs/platform/hosted-mcp-servers/references/reference/sobject-reads.html",
  },
  "47662908": {
    name: "Google Sheets via the bundled gog skill",
    setup:
      "Set up the bundled gog skill and its CLI prerequisite, then authorize the intended Google account for Sheets. Select the spreadsheet/range and use `gog sheets get` for reads. Preserve this optional alternative to CRM data. Setup: https://gogcli.sh",
  },
};

export function grokPluginSetup(pluginId: string): { name: string; setup: string } | undefined {
  return Object.hasOwn(EQUIVALENTS, pluginId) ? EQUIVALENTS[pluginId] : undefined;
}

export const GROK_TOOL_TRANSLATION_NOTE =
  "Grok plugin IDs and tool names are not native tool contracts. Follow the destination integration's installed skill/tool schema; Grok connect cards, secret-request, and plugin-specific operation names may not exist. Installation does not establish sign-in, permissions, or successful execution. Retain optional/fallback choices from the source and configure only the integrations needed.";
