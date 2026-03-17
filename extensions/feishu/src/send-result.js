function assertFeishuMessageApiSuccess(response, errorPrefix) {
  if (response.code !== 0) {
    throw new Error(`${errorPrefix}: ${response.msg || `code ${response.code}`}`);
  }
}
function toFeishuSendResult(response, chatId) {
  return {
    messageId: response.data?.message_id ?? "unknown",
    chatId
  };
}
export {
  assertFeishuMessageApiSuccess,
  toFeishuSendResult
};
