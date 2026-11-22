export function lastBrowserFetchCall(calls: readonly (readonly unknown[])[]): {
  url: string;
  options: { body?: string; timeoutMs?: number };
} {
  const call = calls.at(-1);
  if (!call) {
    throw new Error("fetchBrowserJson was not called");
  }
  return {
    url: String(call[0]),
    options: call[1] as { body?: string; timeoutMs?: number },
  };
}
