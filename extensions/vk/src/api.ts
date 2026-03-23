const VK_API_BASE = "https://api.vk.com/method";
const VK_API_VERSION = "5.131";

export type VkLongPollServer = {
  key: string;
  server: string;
  ts: string;
};

export type VkLongPollResponse = {
  ts: string;
  updates?: unknown[];
  failed?: number;
};

type VkApiErrorResponse = {
  error: {
    error_code: number;
    error_msg: string;
  };
};

type VkApiEnvelope<T> =
  | {
      response: T;
    }
  | VkApiErrorResponse;

export class VkApiError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(`VK API error ${String(code)}: ${message}`);
    this.name = "VkApiError";
    this.code = code;
  }
}

async function readVkJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`VK request failed with status ${String(response.status)}`);
  }
  return (await response.json()) as T;
}

export async function vkApi<T>(
  token: string,
  method: string,
  params: Record<string, string | number | undefined>,
): Promise<T> {
  const url = new URL(`${VK_API_BASE}/${method}`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("v", VK_API_VERSION);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  const json = await readVkJson<VkApiEnvelope<T>>(await fetch(url));
  if ("error" in json) {
    throw new VkApiError(json.error.error_code, json.error.error_msg);
  }
  return json.response;
}

export async function getVkGroupsById(token: string): Promise<
  Array<{
    id: number;
    name?: string;
    screen_name?: string;
  }>
> {
  return await vkApi(token, "groups.getById", {});
}

export async function sendVkMessage(params: {
  token: string;
  peerId: number;
  text: string;
}): Promise<{ messageId: string }> {
  const randomId = Math.floor(Math.random() * 2 ** 31);
  const response = await vkApi<number>(params.token, "messages.send", {
    peer_id: params.peerId,
    message: params.text,
    random_id: randomId,
  });
  return { messageId: String(response) };
}

export async function getVkLongPollServer(
  token: string,
  groupId: number,
): Promise<VkLongPollServer> {
  return await vkApi(token, "groups.getLongPollServer", {
    group_id: groupId,
  });
}

export async function pollVkLongPoll(params: {
  server: string;
  key: string;
  ts: string;
  waitSeconds?: number;
}): Promise<VkLongPollResponse> {
  const url = new URL(params.server);
  url.searchParams.set("act", "a_check");
  url.searchParams.set("key", params.key);
  url.searchParams.set("ts", params.ts);
  url.searchParams.set("wait", String(params.waitSeconds ?? 25));
  return await readVkJson<VkLongPollResponse>(await fetch(url));
}
