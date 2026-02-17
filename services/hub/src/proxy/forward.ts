export async function forwardTobridge(params: {
  bridgeUrl: string;
  path: string;
  rawBody: string;
  headers: Record<string, string>;
}): Promise<Response> {
  const url = `${params.bridgeUrl.replace(/\/+$/, "")}${params.path}`;

  return fetch(url, {
    method: "POST",
    headers: params.headers,
    body: params.rawBody,
  });
}
