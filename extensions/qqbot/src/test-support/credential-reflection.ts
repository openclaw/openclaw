const PERCENT_ESCAPE_RE = /%[0-9A-F]{2}/g;

export function lowercasePercentEscapes(value: string): string {
  return value.replace(PERCENT_ESCAPE_RE, (escape) => escape.toLowerCase());
}

export function stringifyWithSlashEscapedCredential(value: unknown, credential: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("expected a JSON-serializable credential reflection fixture");
  }
  return serialized.replaceAll(credential, credential.replaceAll("/", "\\/"));
}
