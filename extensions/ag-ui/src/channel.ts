import type { ChannelPlugin } from "openclaw/plugin-sdk";

type ResolvedAguiAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

export const aguiChannelPlugin: ChannelPlugin<ResolvedAguiAccount> = {
  id: "ag-ui",
  meta: {
    id: "ag-ui",
    label: "AG-UI",
    selectionLabel: "AG-UI",
    docsPath: "/channels/agui",
    docsLabel: "agui",
    blurb: "AG-UI protocol endpoint for AG-UI clients.",
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
    idLabel: "aguiDeviceId",
    normalizeAllowEntry: (entry: string) => entry.replace(/^ag-ui:/i, "").toLowerCase(),
  },
};
