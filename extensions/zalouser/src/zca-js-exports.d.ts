declare module "zca-js" {
  export enum ThreadType {
    User = 0,
    Group = 1,
  }

  export enum LoginQRCallbackEventType {
    QRCodeGenerated = 0,
    QRCodeExpired = 1,
    QRCodeScanned = 2,
    QRCodeDeclined = 3,
    GotLoginInfo = 4,
  }

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
    type: ThreadType;
    threadId: string;
    isSelf: boolean;
    data: Record<string, unknown>;
  };

  export type LoginQRCallbackEvent =
    | {
        type: LoginQRCallbackEventType.QRCodeGenerated;
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
        type: LoginQRCallbackEventType.QRCodeExpired;
        data: null;
        actions: {
          retry: () => unknown;
          abort: () => unknown;
        };
      }
    | {
        type: LoginQRCallbackEventType.QRCodeScanned;
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
        type: LoginQRCallbackEventType.QRCodeDeclined;
        data: {
          code: string;
        };
        actions: {
          retry: () => unknown;
          abort: () => unknown;
        };
      }
    | {
        type: LoginQRCallbackEventType.GotLoginInfo;
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

  export class API {
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
    fetchAccountInfo(): Promise<{ profile: User } | User>;
    getAllFriends(): Promise<User[]>;
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
      type?: ThreadType,
    ): Promise<{
      message?: { msgId?: string | number } | null;
      attachment?: Array<{ msgId?: string | number }>;
    }>;
    sendLink(
      payload: { link: string; msg?: string },
      threadId: string,
      type?: ThreadType,
    ): Promise<{ msgId?: string | number }>;
  }

  export class Zalo {
    constructor(options?: { logging?: boolean; selfListen?: boolean });
    login(credentials: Credentials): Promise<API>;
    loginQR(
      options?: { userAgent?: string; language?: string; qrPath?: string },
      callback?: (event: LoginQRCallbackEvent) => unknown,
    ): Promise<API>;
  }
}
