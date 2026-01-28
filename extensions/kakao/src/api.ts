/**
 * KakaoWork Bot API client
 * @see https://docs.kakaoi.ai/kakao_work/webapireference/
 */

const KAKAO_API_BASE = "https://api.kakaowork.com/v1";

export type KakaoFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type KakaoApiResponse<T = unknown> = {
  success: boolean;
  error?: {
    code: string;
    message: string;
  };
} & T;

export type KakaoBotInfo = {
  title: string;
  status: "activated" | "deactivated";
};

export type KakaoConversation = {
  id: string;
  type: "dm" | "group";
  users_count: number;
  avatar_url?: string;
  name?: string;
};

export type KakaoMessage = {
  id: string;
  text: string;
  user_id: number;
  conversation_id: number;
  send_time: string;
  update_time: string;
  blocks?: KakaoBlock[];
};

export type KakaoBlock = {
  type: string;
  text?: string;
  markdown?: boolean;
  inlines?: KakaoInline[];
};

export type KakaoInline = {
  type: string;
  text?: string;
  bold?: boolean;
};

export type KakaoUser = {
  id: number;
  name: string;
  email?: string;
  department?: string;
  position?: string;
  avatar_url?: string;
};

export type KakaoReactiveEvent = {
  type: "submit_action" | "request_modal" | "submission";
  action_time: string;
  message?: {
    id: string;
    text: string;
    user_id: number;
    conversation_id: number;
    blocks?: KakaoBlock[];
  };
  react_user_id: number;
  action_name?: string;
  value?: string;
  actions?: Record<string, string>;
};

export class KakaoApiError extends Error {
  constructor(
    message: string,
    public readonly errorCode?: string,
    public readonly description?: string,
  ) {
    super(message);
    this.name = "KakaoApiError";
  }
}

/**
 * Call the KakaoWork API
 */
export async function callKakaoApi<T = unknown>(
  method: string,
  appKey: string,
  body?: Record<string, unknown>,
  options?: { timeoutMs?: number; fetch?: KakaoFetch; httpMethod?: "GET" | "POST" },
): Promise<KakaoApiResponse<T>> {
  const url = `${KAKAO_API_BASE}/${method}`;
  const controller = new AbortController();
  const timeoutId = options?.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : undefined;
  const fetcher = options?.fetch ?? fetch;
  const httpMethod = options?.httpMethod ?? "POST";

  try {
    const response = await fetcher(url, {
      method: httpMethod,
      headers: {
        "Authorization": `Bearer ${appKey}`,
        "Content-Type": "application/json",
      },
      body: httpMethod === "POST" && body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const data = (await response.json()) as KakaoApiResponse<T>;

    if (!data.success) {
      throw new KakaoApiError(
        data.error?.message ?? `KakaoWork API error: ${method}`,
        data.error?.code,
        data.error?.message,
      );
    }

    return data;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Get bot info
 */
export async function getBotInfo(
  appKey: string,
  timeoutMs?: number,
  fetcher?: KakaoFetch,
): Promise<KakaoApiResponse<{ info: KakaoBotInfo }>> {
  return callKakaoApi<{ info: KakaoBotInfo }>("bots.info", appKey, undefined, {
    timeoutMs,
    fetch: fetcher,
    httpMethod: "GET",
  });
}

/**
 * Open or get existing conversation with a user
 */
export async function openConversation(
  appKey: string,
  userId: number,
  fetcher?: KakaoFetch,
): Promise<KakaoApiResponse<{ conversation: KakaoConversation }>> {
  return callKakaoApi<{ conversation: KakaoConversation }>(
    "conversations.open",
    appKey,
    { user_id: userId },
    { fetch: fetcher },
  );
}

/**
 * List bot conversations
 */
export async function listConversations(
  appKey: string,
  params?: { cursor?: string; limit?: number },
  fetcher?: KakaoFetch,
): Promise<KakaoApiResponse<{ conversations: KakaoConversation[]; cursor?: string }>> {
  return callKakaoApi<{ conversations: KakaoConversation[]; cursor?: string }>(
    "conversations.list",
    appKey,
    params,
    { fetch: fetcher },
  );
}

/**
 * Send a text message to a conversation
 */
export async function sendMessage(
  appKey: string,
  params: { conversation_id: number; text: string; blocks?: KakaoBlock[] },
  fetcher?: KakaoFetch,
): Promise<KakaoApiResponse<{ message: KakaoMessage }>> {
  return callKakaoApi<{ message: KakaoMessage }>("messages.send", appKey, params, {
    fetch: fetcher,
  });
}

/**
 * Send a message by user email
 */
export async function sendMessageByEmail(
  appKey: string,
  params: { email: string; text: string; blocks?: KakaoBlock[] },
  fetcher?: KakaoFetch,
): Promise<KakaoApiResponse<{ message: KakaoMessage }>> {
  return callKakaoApi<{ message: KakaoMessage }>("messages.send_by_email", appKey, params, {
    fetch: fetcher,
  });
}

/**
 * Get user info by ID
 */
export async function getUserInfo(
  appKey: string,
  userId: number,
  fetcher?: KakaoFetch,
): Promise<KakaoApiResponse<{ user: KakaoUser }>> {
  return callKakaoApi<{ user: KakaoUser }>(
    "users.info",
    appKey,
    { user_id: userId },
    { fetch: fetcher },
  );
}

/**
 * List workspace users
 */
export async function listUsers(
  appKey: string,
  params?: { cursor?: string; limit?: number },
  fetcher?: KakaoFetch,
): Promise<KakaoApiResponse<{ users: KakaoUser[]; cursor?: string }>> {
  return callKakaoApi<{ users: KakaoUser[]; cursor?: string }>("users.list", appKey, params, {
    fetch: fetcher,
  });
}
