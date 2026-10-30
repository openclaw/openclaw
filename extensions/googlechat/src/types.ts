export type GoogleChatSpace = {
  name?: string;
  displayName?: string;
  type?: string;
  /** Current Google Chat field that replaces the deprecated `type` field. */
  spaceType?: string;
  /** True when the space is a 1:1 DM between a user and the Chat app. */
  singleUserBotDm?: boolean;
};

export type GoogleChatUser = {
  name?: string;
  displayName?: string;
  email?: string;
  type?: string;
};

export type GoogleChatAttachment = {
  name?: string;
  contentName?: string;
  contentType?: string;
  thumbnailUri?: string;
  downloadUri?: string;
  source?: string;
  attachmentDataRef?: {
    resourceName?: string;
    attachmentUploadToken?: string;
  };
  driveDataRef?: Record<string, unknown>;
};

export type GoogleChatAnnotation = {
  type?: string;
  startIndex?: number;
  length?: number;
  userMention?: {
    user?: GoogleChatUser;
    type?: string;
  };
  slashCommand?: Record<string, unknown>;
  richLinkMetadata?: Record<string, unknown>;
  customEmojiMetadata?: Record<string, unknown>;
};

export type GoogleChatMessage = {
  name?: string;
  text?: string;
  argumentText?: string;
  sender?: GoogleChatUser;
  thread?: {
    name?: string;
    threadKey?: string;
  };
  cardsV2?: GoogleChatCardV2[];
  attachment?: GoogleChatAttachment[];
  annotations?: GoogleChatAnnotation[];
};

export type GoogleChatActionParameter = {
  key?: string;
  value?: string;
};

export type GoogleChatAction = {
  actionMethodName?: string;
  parameters?: GoogleChatActionParameter[];
};

export type GoogleChatEvent = {
  type?: string;
  eventType?: string;
  eventTime?: string;
  space?: GoogleChatSpace;
  user?: GoogleChatUser;
  message?: GoogleChatMessage;
  action?: GoogleChatAction;
  common?: {
    invokedFunction?: string;
    parameters?: Record<string, string>;
  };
  commonEventObject?: {
    invokedFunction?: string;
    parameters?: Record<string, string>;
  };
};

export type GoogleChatCardV2 = {
  cardId?: string;
  card: {
    header?: {
      title?: string;
      subtitle?: string;
      imageType?: "SQUARE" | "CIRCLE";
    };
    sections?: Array<{
      header?: string;
      collapsible?: boolean;
      uncollapsibleWidgetsCount?: number;
      widgets?: (
        | {
            textParagraph: {
              text: string;
            };
          }
        | {
            buttonList: {
              buttons: Array<{
                text: string;
                onClick: {
                  action: {
                    function: string;
                    parameters?: GoogleChatActionParameter[];
                    loadIndicator?: "SPINNER" | "NONE";
                  };
                };
              }>;
            };
          }
        | { divider: Record<string, never> }
      )[];
    }>;
  };
};
