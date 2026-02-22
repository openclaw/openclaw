export type WecomDmConfig = {
  policy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
};

export type WecomAccountConfig = {
  name?: string;
  enabled?: boolean;

  webhookPath?: string;
  token?: string;
  encodingAESKey?: string;
  receiveId?: string;

  streamPlaceholderContent?: string;

  dm?: WecomDmConfig;
  welcomeText?: string;
};

export type WecomConfig = WecomAccountConfig & {
  accounts?: Record<string, WecomAccountConfig>;
  defaultAccount?: string;
};

export type ResolvedWecomAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  token?: string;
  encodingAESKey?: string;
  receiveId: string;
  config: WecomAccountConfig;
};

export type WecomInboundBase = {
  msgid?: string;
  aibotid?: string;
  chattype?: "single" | "group";
  chatid?: string;
  response_url?: string;
  from?: { userid?: string; corpid?: string };
  msgtype?: string;
};

export type WecomInboundText = WecomInboundBase & {
  msgtype: "text";
  text?: { content?: string };
  quote?: unknown;
};

export type WecomInboundVoice = WecomInboundBase & {
  msgtype: "voice";
  voice?: { content?: string };
  quote?: unknown;
};

export type WecomInboundStreamRefresh = WecomInboundBase & {
  msgtype: "stream";
  stream?: { id?: string };
};

export type WecomInboundEvent = WecomInboundBase & {
  msgtype: "event";
  create_time?: number;
  event?: {
    eventtype?: string;
    [key: string]: unknown;
  };
};

export type WecomInboundQuote = {
  msgtype?: "text" | "image" | "mixed" | "voice" | "file";
  text?: { content?: string };
  image?: { url?: string };
  mixed?: {
    msg_item?: Array<{
      msgtype: "text" | "image";
      text?: { content?: string };
      image?: { url?: string };
    }>;
  };
  voice?: { content?: string };
  file?: { url?: string };
};

export type WecomInboundMessage =
  | (WecomInboundText & { quote?: WecomInboundQuote })
  | WecomInboundVoice
  | WecomInboundStreamRefresh
  | WecomInboundEvent
  | (WecomInboundBase & { quote?: WecomInboundQuote } & Record<string, unknown>);

export type WecomTemplateCard = {
  card_type:
    | "text_notice"
    | "news_notice"
    | "button_interaction"
    | "vote_interaction"
    | "multiple_interaction";
  source?: { icon_url?: string; desc?: string; desc_color?: number };
  main_title?: { title?: string; desc?: string };
  task_id?: string;
  button_list?: Array<{ text: string; style?: number; key: string }>;
  sub_title_text?: string;
  horizontal_content_list?: Array<{
    keyname: string;
    value?: string;
    type?: number;
    url?: string;
    userid?: string;
  }>;
  card_action?: { type: number; url?: string; appid?: string; pagepath?: string };
  action_menu?: { desc: string; action_list: Array<{ text: string; key: string }> };
  select_list?: Array<{
    question_key: string;
    title?: string;
    selected_id?: string;
    option_list: Array<{ id: string; text: string }>;
  }>;
  submit_button?: { text: string; key: string };
  checkbox?: {
    question_key: string;
    option_list: Array<{ id: string; text: string; is_checked?: boolean }>;
    mode?: number;
  };
};

export type WecomInboundTemplateCardEvent = WecomInboundBase & {
  msgtype: "event";
  event: {
    eventtype: "template_card_event";
    template_card_event: {
      card_type: string;
      event_key: string;
      task_id: string;
      selected_items?: {
        selected_item: Array<{
          question_key: string;
          option_ids: { option_id: string[] };
        }>;
      };
    };
  };
};

/**
 * Template card event payload (button click, checkbox, select)
 */
export type WecomTemplateCardEventPayload = {
  card_type: string;
  event_key: string;
  task_id: string;
  response_code?: string;
  selected_items?: {
    question_key?: string;
    option_ids?: string[];
  };
};

/**
 * Outbound message types that can be sent via response_url
 */
export type WecomOutboundMessage =
  | { msgtype: "text"; text: { content: string } }
  | { msgtype: "markdown"; markdown: { content: string } }
  | { msgtype: "template_card"; template_card: WecomTemplateCard };
