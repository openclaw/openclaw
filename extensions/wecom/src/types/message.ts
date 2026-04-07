/**
 * WeCom message type definitions
 * Shared by Bot and Agent modes
 */

/**
 * **WecomBotInboundBase (Bot inbound message base)**
 *
 * Base fields for JSON-format callbacks in Bot mode.
 * @property msgid - Message ID
 * @property aibotid - Bot ID
 * @property chattype - Chat type: "single" | "group"
 * @property chatid - Group chat ID (only present for group chats)
 * @property response_url - Downstream reply URL (for converting passive response to active push)
 * @property from - Sender information
 */
export type WecomBotInboundBase = {
  msgid?: string;
  aibotid?: string;
  chattype?: "single" | "group";
  chatid?: string;
  response_url?: string;
  from?: { userid?: string; corpid?: string };
  msgtype?: string;
  /** Attachment count (present in some messages) */
  attachment_count?: number;
};

export type WecomBotInboundText = WecomBotInboundBase & {
  msgtype: "text";
  text?: { content?: string };
  quote?: WecomInboundQuote;
};

export type WecomBotInboundVoice = WecomBotInboundBase & {
  msgtype: "voice";
  voice?: { content?: string };
  quote?: WecomInboundQuote;
};

export type WecomBotInboundVideo = WecomBotInboundBase & {
  msgtype: "video";
  video?: { url?: string; aeskey?: string };
  quote?: WecomInboundQuote;
};

export type WecomBotInboundStreamRefresh = WecomBotInboundBase & {
  msgtype: "stream";
  stream?: { id?: string };
};

export type WecomBotInboundEvent = WecomBotInboundBase & {
  msgtype: "event";
  create_time?: number;
  event?: {
    eventtype?: string;
    [key: string]: unknown;
  };
};

/**
 * **WecomInboundQuote (Quoted message)**
 *
 * Original content quoted in a message (e.g. replying to a specific message).
 * Supports quoting text, image, mixed type, voice, file, etc.
 */
export type WecomInboundQuote = {
  msgtype?: "text" | "image" | "mixed" | "voice" | "file" | "video";
  /** Quoted text content */
  text?: { content?: string };
  /** Quoted image URL */
  image?: { url?: string };
  /** Quoted mixed message (text + image) */
  mixed?: {
    msg_item?: Array<{
      msgtype: "text" | "image";
      text?: { content?: string };
      image?: { url?: string };
    }>;
  };
  /** Quoted voice */
  voice?: { content?: string };
  /** Quoted file */
  file?: { url?: string };
  /** Quoted video */
  video?: { url?: string };
};

export type WecomBotInboundMessage =
  | WecomBotInboundText
  | WecomBotInboundVoice
  | WecomBotInboundVideo
  | WecomBotInboundStreamRefresh
  | WecomBotInboundEvent
  | (WecomBotInboundBase & { quote?: WecomInboundQuote } & Record<string, unknown>);

/**
 * **WecomAgentInboundMessage (Agent inbound message)**
 *
 * Flattened message structure parsed from XML in Agent mode.
 * Key names maintain PascalCase (e.g. `ToUserName`).
 */
export type WecomAgentInboundMessage = {
  ToUserName?: string;
  FromUserName?: string;
  CreateTime?: number;
  MsgType?: string;
  MsgId?: string;
  AgentID?: number;
  // Text message
  Content?: string;
  // Image message
  PicUrl?: string;
  MediaId?: string;
  // File message
  FileName?: string;
  // Voice message
  Format?: string;
  Recognition?: string;
  // Video message
  ThumbMediaId?: string;
  // Location message
  Location_X?: number;
  Location_Y?: number;
  Scale?: number;
  Label?: string;
  // Link message
  Title?: string;
  Description?: string;
  Url?: string;
  // Event message
  Event?: string;
  EventKey?: string;
  // Group chat
  ChatId?: string;
};

/**
 * **WecomTemplateCard (Template card)**
 *
 * Complex interactive card structure.
 * @property card_type - Card type: "text_notice" | "news_notice" | "button_interaction" ...
 * @property source - Source information
 * @property main_title - Main title
 * @property sub_title_text - Subtitle
 * @property horizontal_content_list - Horizontally arranged key-value list
 * @property button_list - Button list
 */
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

/**
 * Outbound message type
 */
export type WecomOutboundMessage =
  | { msgtype: "text"; text: { content: string } }
  | { msgtype: "markdown"; markdown: { content: string } }
  | { msgtype: "template_card"; template_card: WecomTemplateCard };
