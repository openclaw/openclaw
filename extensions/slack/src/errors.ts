import type { CodedError, WebAPICallResult } from "@slack/web-api";

export function formatSlackError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const { code, data } = err as CodedError & {
    data?: WebAPICallResult & { needed?: string; provided?: string };
  };
  const parts: string[] = [];
  if (code) parts.push(`code=${code}`);
  if (data?.error) parts.push(`error=${data.error}`);
  if (data?.needed) parts.push(`needed=${data.needed}`);
  if (data?.provided) parts.push(`provided=${data.provided}`);
  const meta = data?.response_metadata;
  if (meta?.retryAfter) parts.push(`retryAfter=${meta.retryAfter}`);
  if (meta?.scopes?.length) parts.push(`scopes=${meta.scopes.join(",")}`);
  if (meta?.acceptedScopes?.length) parts.push(`acceptedScopes=${meta.acceptedScopes.join(",")}`);
  if (meta?.messages?.length) parts.push(`messages=${meta.messages.join(" | ")}`);
  return parts.length ? `${err.message} [${parts.join(" ")}]` : err.message;
}
