import { isRevokedProxyError } from "./errors.js";
async function withRevokedProxyFallback(params) {
  try {
    return await params.run();
  } catch (err) {
    if (!isRevokedProxyError(err)) {
      throw err;
    }
    params.onRevokedLog?.();
    return await params.onRevoked();
  }
}
export {
  withRevokedProxyFallback
};
