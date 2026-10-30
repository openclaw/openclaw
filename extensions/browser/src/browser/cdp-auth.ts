function decodeUrlUserInfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Merge URL basic-auth credentials into headers without overriding explicit auth. */
export function getHeadersWithAuth(url: string, headers: Record<string, string> = {}) {
  const mergedHeaders = { ...headers };
  const parsed = URL.parse(url);
  if (
    !parsed ||
    (!parsed.username && !parsed.password) ||
    Object.keys(mergedHeaders).some((key) => key.trim().toLowerCase() === "authorization")
  ) {
    return mergedHeaders;
  }
  const username = decodeUrlUserInfo(parsed.username);
  const password = decodeUrlUserInfo(parsed.password);
  const auth = Buffer.from(`${username}:${password}`).toString("base64");
  return { ...mergedHeaders, Authorization: `Basic ${auth}` };
}

/** Remove URL userinfo after callers have converted it to an Authorization header. */
export function stripCdpUrlCredentials(url: string): string {
  const parsed = URL.parse(url);
  if (!parsed || (!parsed.username && !parsed.password)) {
    return url;
  }
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}
