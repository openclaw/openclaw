export interface WebexConfig {
  enabled?: boolean;
  botToken?: string;
  tokenFile?: string;
  webhookUrl?: string;
  webhookPath?: string;
  webhookSecret?: string;
  dmPolicy?: "pairing" | "open" | "disabled";
  allowFrom?: string[];
  name?: string;
  accounts?: Record<string, WebexAccountConfig>;
}

export interface WebexAccountConfig {
  enabled?: boolean;
  botToken?: string;
  tokenFile?: string;
  webhookUrl?: string;
  webhookPath?: string;
  webhookSecret?: string;
  dmPolicy?: "pairing" | "open" | "disabled";
  allowFrom?: string[];
  name?: string;
}

export interface ResolvedWebexAccount {
  accountId: string;
  enabled: boolean;
  token: string;
  tokenSource: "config" | "file" | "env" | "none";
  config: WebexAccountConfig;
  name?: string;
}

// Webex API types
export interface WebexMessage {
  id: string;
  roomId?: string;
  roomType: "direct" | "group";
  toPersonId?: string;
  toPersonEmail?: string;
  text?: string;
  markdown?: string;
  personId: string;
  personEmail: string;
  created: string;
  mentionedPeople?: string[];
  mentionedGroups?: string[];
}

export interface WebexPerson {
  id: string;
  emails: string[];
  phoneNumbers?: string[];
  displayName: string;
  nickName?: string;
  userName?: string;
  avatar?: string;
  orgId?: string;
  created: string;
  status: string;
  type: "person" | "bot";
}

export interface WebexRoom {
  id: string;
  title?: string;
  type: "direct" | "group";
  isLocked?: boolean;
  teamId?: string;
  created: string;
  creatorId?: string;
}

export interface WebexWebhookEvent {
  id: string;
  name: string;
  resource: string;
  event: string;
  filter?: string;
  data: {
    id: string;
    roomId?: string;
    personId?: string;
    personEmail?: string;
    created?: string;
  };
}

export interface WebexProbeResult {
  ok: boolean;
  bot?: WebexPerson;
  error?: string;
  statusCode?: number;
}