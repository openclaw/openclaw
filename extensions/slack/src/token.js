import { normalizeResolvedSecretInputString } from "../../../src/config/types.secrets.js";
function normalizeSlackToken(raw) {
  return normalizeResolvedSecretInputString({
    value: raw,
    path: "channels.slack.*.token"
  });
}
function resolveSlackBotToken(raw, path = "channels.slack.botToken") {
  return normalizeResolvedSecretInputString({ value: raw, path });
}
function resolveSlackAppToken(raw, path = "channels.slack.appToken") {
  return normalizeResolvedSecretInputString({ value: raw, path });
}
function resolveSlackUserToken(raw, path = "channels.slack.userToken") {
  return normalizeResolvedSecretInputString({ value: raw, path });
}
export {
  normalizeSlackToken,
  resolveSlackAppToken,
  resolveSlackBotToken,
  resolveSlackUserToken
};
