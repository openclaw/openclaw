export type NaverWorksAccount = {
  accountId: string;
  enabled: boolean;
  webhookPath: string;
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom: string[];
  botName: string;
  strictBinding: boolean;
  botSecret?: string;
  botId?: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  serviceAccount?: string;
  privateKey?: string;
  scope?: string;
  tokenUrl: string;
  jwtIssuer?: string;
  apiBaseUrl: string;
  markdownMode: "plain" | "auto-flex";
  markdownTheme: "light" | "dark" | "auto";
};

export type NaverWorksInboundEvent = {
  raw: Record<string, unknown>;
  userId: string;
  teamId?: string;
  text?: string;
  location?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
    name?: string;
    address?: string;
    isLive?: boolean;
  };
  mediaUrl?: string;
  mediaKind?: "image" | "audio" | "file";
  mediaMimeType?: string;
  mediaFileName?: string;
  mediaDurationMs?: number;
  isDirect: boolean;
  senderName?: string;
};
