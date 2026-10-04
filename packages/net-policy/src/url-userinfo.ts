/** Strip username/password credentials from a URL string when it parses. */
export function stripUrlUserInfo(value: string): string {
  const parsed = URL.parse(value);
  if (!parsed || (!parsed.username && !parsed.password)) {
    return value;
  }
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}
