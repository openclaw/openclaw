export function slackRequest(id: number, method: string, fields: Record<string, string> = {}) {
  return {
    id,
    flowId: String(id),
    host: "slack.com",
    kind: "request",
    method: "POST",
    path: `/api/${method}`,
    dataText: new URLSearchParams({ channel: "C123", ...fields }).toString(),
  };
}

export function slackResponse(id: number, fields: Record<string, unknown> = {}, status = 200) {
  return {
    flowId: String(id),
    kind: "response",
    status,
    dataText: JSON.stringify({ channel: "C123", ok: true, ts: "2.000000", ...fields }),
  };
}
