import * as zcaJsRuntime from "zca-js";

const zcaJs = zcaJsRuntime as unknown as {
  ThreadType: unknown;
  LoginQRCallbackEventType: unknown;
  Reactions: unknown;
  Zalo: unknown;
};

export const ThreadType = zcaJs.ThreadType as {
  User: 0;
  Group: 1;
};

export const LoginQRCallbackEventType = zcaJs.LoginQRCallbackEventType as {
  QRCodeGenerated: 0;
  QRCodeExpired: 1;
  QRCodeScanned: 2;
  QRCodeDeclined: 3;
  GotLoginInfo: 4;
};

export const Reactions = zcaJs.Reactions as Record<string, string> & {
  HEART: string;
  LIKE: string;
  HAHA: string;
  WOW: string;
  CRY: string;
  ANGRY: string;
  NONE: string;
};

// Mirror zca-js sendMessage style constants locally because the package root
// typing surface does not consistently expose TextStyle/Style to tsgo.
export const TextStyle = {
  Bold: "b",
  Italic: "i",
  Underline: "u",
  StrikeThrough: "s",
  Red: "c_db342e",
  Orange: "c_f27806",
  Yellow: "c_f7b503",
  Green: "c_15a85f",
  Small: "f_13",
  Big: "f_18",
  UnorderedList: "lst_1",
  OrderedList: "lst_2",
  Indent: "ind_$",
} as const;

type TextStyleValue = (typeof TextStyle)[keyof typeof TextStyle];

export type Style =
  | {
      start: number;
      len: number;
      st: Exclude<TextStyleValue, typeof TextStyle.Indent>;
    }
  | {
      start: number;
      len: number;
      st: typeof TextStyle.Indent;
      indentSize?: number;
    };

export type Credentials = {
  imei: string;
  cookie: unknown;
  userAgent: string;
  language?: string;
};

export type User = {
  userId: string;
  username: string;
  displayName: string;
  zaloName: string;
  avatar: string;
};

export type GroupInfo = {
  groupId: string;
  name: string;
  totalMember?: number;
  memberIds?: unknown[];
  currentMems?: Array<{
    id?: unknown;
    dName?: string;
    zaloName?: string;
    avatar?: string;
  }>;
};

export type Message = {
  type: number;
  threadId: string;
  isSelf: boolean;
  data: Record<string, unknown>;
};

export type LoginQRCallbackEvent =
  | {
      type: 0;
      data: {
        code: string;
        image: string;
      };
      actions: {
        saveToFile: (qrPath?: string) => Promise<unknown>;
        retry: () => unknown;
        abort: () => unknown;
      };
    }
  | {
      type: 1;
      data: null;
      actions: {
        retry: () => unknown;
        abort: () => unknown;
      };
    }
  | {
      type: 2;
      data: {
        avatar: string;
        display_name: string;
      };
      actions: {
        retry: () => unknown;
        abort: () => unknown;
      };
    }
  | {
      type: 3;
      data: {
        code: string;
      };
      actions: {
        retry: () => unknown;
        abort: () => unknown;
      };
    }
  | {
      type: 4;
      data: {
        cookie: unknown;
        imei: string;
        userAgent: string;
      };
      actions: null;
    };

export type Listener = {
  on(event: "message", callback: (message: Message) => void): void;
  on(event: "error", callback: (error: unknown) => void): void;
  on(event: "closed", callback: (code: number, reason: string) => void): void;
  off(event: "message", callback: (message: Message) => void): void;
  off(event: "error", callback: (error: unknown) => void): void;
  off(event: "closed", callback: (code: number, reason: string) => void): void;
  start(opts?: { retryOnClose?: boolean }): void;
  stop(): void;
};

type DeliveryEventMessage = {
  msgId: string;
  cliMsgId: string;
  uidFrom: string;
  idTo: string;
  msgType: string;
  st: number;
  at: number;
  cmd: number;
  ts: string | number;
};

type DeliveryEventMessages = DeliveryEventMessage | DeliveryEventMessage[];

export type API = {
  listener: Listener;
  getContext(): {
    imei: string;
    userAgent: string;
    language?: string;
  };
  getCookie(): {
    toJSON(): {
      cookies: unknown[];
    };
  };
  fetchAccountInfo(): Promise<User | { profile: User }>;
  getAllFriends(): Promise<User[]>;
  getOwnId(): string;
  getAllGroups(): Promise<{
    gridVerMap: Record<string, string>;
  }>;
  getGroupInfo(groupId: string | string[]): Promise<{
    gridInfoMap: Record<string, GroupInfo & { memVerList?: unknown }>;
  }>;
  getGroupMembersInfo(memberId: string | string[]): Promise<{
    profiles: Record<
      string,
      {
        id?: string;
        displayName?: string;
        zaloName?: string;
        avatar?: string;
      }
    >;
  }>;
  sendMessage(
    message: string | Record<string, unknown>,
    threadId: string,
    type?: number,
  ): Promise<{
    msgId?: string | number;
    message?: { msgId?: string | number } | null;
    attachment?: Array<{ msgId?: string | number }>;
  }>;
  uploadAttachment(
    sources:
      | string
      | {
          data: Buffer;
          filename: `${string}.${string}`;
          metadata: {
            totalSize: number;
            width?: number;
            height?: number;
          };
        }
      | Array<
          | string
          | {
              data: Buffer;
              filename: `${string}.${string}`;
              metadata: {
                totalSize: number;
                width?: number;
                height?: number;
              };
            }
        >,
    threadId: string,
    type?: number,
  ): Promise<
    Array<{
      fileType: "image" | "video" | "others";
      fileUrl?: string;
      msgId?: string | number;
      fileId?: string;
      fileName?: string;
    }>
  >;
  sendVoice(
    options: {
      voiceUrl: string;
      ttl?: number;
    },
    threadId: string,
    type?: number,
  ): Promise<{ msgId?: string | number }>;
  sendLink(
    payload: { link: string; msg?: string },
    threadId: string,
    type?: number,
  ): Promise<{ msgId?: string | number }>;
  sendTypingEvent(threadId: string, type?: number, destType?: number): Promise<{ status: number }>;
  addReaction(
    icon: string | { rType: number; source: number; icon: string },
    dest: {
      data: {
        msgId: string;
        cliMsgId: string;
      };
      threadId: string;
      type: number;
    },
  ): Promise<unknown>;
  sendDeliveredEvent(
    isSeen: boolean,
    messages: DeliveryEventMessages,
    type?: number,
  ): Promise<unknown>;
  sendSeenEvent(messages: DeliveryEventMessages, type?: number): Promise<unknown>;
};

type ZaloCtor = new (options?: { logging?: boolean; selfListen?: boolean }) => {
  login(credentials: Credentials): Promise<API>;
  loginQR(
    options?: { userAgent?: string; language?: string; qrPath?: string },
    callback?: (event: LoginQRCallbackEvent) => unknown,
  ): Promise<API>;
};

export const Zalo = zcaJs.Zalo as unknown as ZaloCtor;
