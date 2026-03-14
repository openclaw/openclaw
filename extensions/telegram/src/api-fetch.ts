import { buildTelegramBotApiUrl } from "./api-root.js";

export async function fetchTelegramChatId(params: {
  token: string;
  chatId: string;
  apiRoot?: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const url = `${buildTelegramBotApiUrl({
    token: params.token,
    method: "getChat",
    apiRoot: params.apiRoot,
  })}?chat_id=${encodeURIComponent(params.chatId)}`;
  try {
    const res = await fetch(url, params.signal ? { signal: params.signal } : undefined);
    if (!res.ok) {
      return null;
    }
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: { id?: number | string };
    } | null;
    const id = data?.ok ? data?.result?.id : undefined;
    if (typeof id === "number" || typeof id === "string") {
      return String(id);
    }
    return null;
  } catch {
    return null;
  }
}
