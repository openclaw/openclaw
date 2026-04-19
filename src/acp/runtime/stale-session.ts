const STALE_ACP_SESSION_MESSAGE_RE =
  /(ACP (session )?metadata is missing|missing ACP metadata|Session is not ACP-enabled|Resource not found|working directory does not exist)/i;

export function isAcpStaleSessionError(params: { code: string; message: string }): boolean {
  if (params.code !== "ACP_SESSION_INIT_FAILED") {
    return false;
  }
  if (!STALE_ACP_SESSION_MESSAGE_RE.test(params.message)) {
    return false;
  }
  return true;
}
