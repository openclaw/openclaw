// Viber-specific types

export interface ViberSender {
  name: string;
  avatar?: string;
}

export interface ViberUser {
  id: string;
  name: string;
  avatar?: string;
  country?: string;
  language?: string;
  api_version?: number;
}

export interface ViberMessage {
  type: string;
  text?: string;
  media?: string;
  file_name?: string;
  size?: number;
  duration?: number;
  sticker_id?: number;
  contact?: {
    name: string;
    phone_number: string;
  };
  location?: {
    lat: number;
    lon: number;
  };
  tracking_data?: string;
}

export interface ViberWebhookEvent {
  event: string;
  timestamp: number;
  chat_hostname?: string;
  message_token?: number;
  sender?: ViberUser;
  message?: ViberMessage;
  user?: ViberUser;
  user_id?: string;
  desc?: string;
  type?: string;
  context?: string;
}

export interface ViberKeyboardButton {
  Columns?: number;
  Rows?: number;
  ActionType?: "reply" | "open-url" | "none";
  ActionBody: string;
  Text?: string;
  TextSize?: "small" | "medium" | "large";
  BgColor?: string;
  Silent?: boolean;
}

export interface ViberKeyboard {
  Type: "keyboard";
  DefaultHeight?: boolean;
  Buttons: ViberKeyboardButton[];
}

export interface ViberSendMessageParams {
  receiver: string;
  type: "text" | "picture" | "video" | "file" | "sticker" | "url" | "location" | "rich_media";
  sender?: ViberSender;
  text?: string;
  media?: string;
  thumbnail?: string;
  file_name?: string;
  size?: number;
  duration?: number;
  sticker_id?: number;
  url?: string;
  lat?: number;
  lon?: number;
  keyboard?: ViberKeyboard;
  tracking_data?: string;
  min_api_version?: number;
  rich_media?: unknown;
}

export interface ViberApiResponse {
  status: number;
  status_message: string;
  message_token?: number;
  chat_hostname?: string;
}

export interface ViberAccountInfo {
  status: number;
  status_message: string;
  id?: string;
  name?: string;
  uri?: string;
  icon?: string;
  background?: string;
  category?: string;
  subcategory?: string;
  location?: { lat: number; lon: number };
  country?: string;
  webhook?: string;
  event_types?: string[];
  subscribers_count?: number;
  members?: ViberUser[];
}

/** Resolved Viber account from config. */
export interface ResolvedViberAccount {
  accountId: string;
  token: string;
  tokenSource: "config" | "env" | "none";
  webhookUrl?: string;
  name?: string;
  avatar?: string;
  enabled: boolean;
  config: {
    dmPolicy?: string;
    allowFrom?: string[];
    webhookUrl?: string;
    webhookPath?: string;
    proxy?: string;
  };
}

/** Viber probe result from get_account_info. */
export interface ViberProbe {
  ok: boolean;
  accountName?: string;
  uri?: string;
  subscribersCount?: number;
  error?: string;
}
