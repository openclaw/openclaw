import {
  resolveReactionLevel
} from "../../../src/utils/reaction-level.js";
import { resolveSignalAccount } from "./accounts.js";
function resolveSignalReactionLevel(params) {
  const account = resolveSignalAccount({
    cfg: params.cfg,
    accountId: params.accountId
  });
  return resolveReactionLevel({
    value: account.config.reactionLevel,
    defaultLevel: "minimal",
    invalidFallback: "minimal"
  });
}
export {
  resolveSignalReactionLevel
};
