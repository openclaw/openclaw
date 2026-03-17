import {
  resolveReactionLevel
} from "../../../src/utils/reaction-level.js";
import { resolveTelegramAccount } from "./accounts.js";
function resolveTelegramReactionLevel(params) {
  const account = resolveTelegramAccount({
    cfg: params.cfg,
    accountId: params.accountId
  });
  return resolveReactionLevel({
    value: account.config.reactionLevel,
    defaultLevel: "minimal",
    invalidFallback: "ack"
  });
}
export {
  resolveTelegramReactionLevel
};
