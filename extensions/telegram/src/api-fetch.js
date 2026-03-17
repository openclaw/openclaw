async function fetchTelegramChatId(params) {
  const url = `https://api.telegram.org/bot${params.token}/getChat?chat_id=${encodeURIComponent(params.chatId)}`;
  try {
    const res = await fetch(url, params.signal ? { signal: params.signal } : void 0);
    if (!res.ok) {
      return null;
    }
    const data = await res.json().catch(() => null);
    const id = data?.ok ? data?.result?.id : void 0;
    if (typeof id === "number" || typeof id === "string") {
      return String(id);
    }
    return null;
  } catch {
    return null;
  }
}
export {
  fetchTelegramChatId
};
