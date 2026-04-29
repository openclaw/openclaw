import type { ChannelPlugin } from "openclaw/plugin-sdk";

type ResolvedAguiAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

export const aguiChannelPlugin: ChannelPlugin<ResolvedAguiAccount> = {
  id: "clawg-ui",
  meta: {
    id: "clawg-ui",
    label: "AG-UI",
    selectionLabel: "AG-UI (CopilotKit / HttpAgent)",
    docsPath: "/channels/agui",
    docsLabel: "agui",
    blurb: "AG-UI protocol endpoint for CopilotKit and HttpAgent clients.",
    order: 90,
  },
  capabilities: {
    chatTypes: ["direct"],
    blockStreaming: true,
  },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({
      accountId: "default",
      enabled: true,
      configured: true,
    }),
    defaultAccountId: () => "default",
  },
  pairing: {
    idLabel: "clawgUiDeviceId",
    normalizeAllowEntry: (entry: string) => entry.replace(/^clawg-ui:/i, "").toLowerCase(),
  },
};
