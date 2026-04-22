export function resolveFeishuReasoningPreviewEnabled(params: {
  storePath: string;
  sessionKey?: string;
}): boolean {
  return params.sessionKey !== undefined;
}
