const DEFAULT_TEXT_CHUNK_LIMIT = 4000;

export function chunkCampfireText(text: string, chunkLimit = DEFAULT_TEXT_CHUNK_LIMIT): string[] {
  const normalizedLimit =
    Number.isFinite(chunkLimit) && chunkLimit > 0 ? Math.floor(chunkLimit) : 1;
  const chunks: string[] = [];

  for (let start = 0; start < text.length; start += normalizedLimit) {
    chunks.push(text.slice(start, start + normalizedLimit));
  }

  return chunks.length > 0 ? chunks : [""];
}

function buildCampfireHeaders(botKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
  };
  const normalizedBotKey = botKey.trim();
  if (normalizedBotKey) {
    headers.Authorization = `Bearer ${normalizedBotKey}`;
  }
  return headers;
}

export async function sendCampfireReply(
  replyUrl: string,
  text: string,
  botKey = "",
): Promise<void> {
  const response = await fetch(replyUrl, {
    method: "POST",
    headers: buildCampfireHeaders(botKey),
    body: text,
  });

  if (!response.ok) {
    throw new Error(`Campfire reply failed: ${response.status} ${response.statusText}`);
  }
}

export async function sendCampfireText(
  replyUrl: string,
  text: string,
  botKey: string,
  chunkLimit = DEFAULT_TEXT_CHUNK_LIMIT,
): Promise<void> {
  const chunks = chunkCampfireText(text, chunkLimit);
  for (const chunk of chunks) {
    await sendCampfireReply(replyUrl, chunk, botKey);
  }
}
