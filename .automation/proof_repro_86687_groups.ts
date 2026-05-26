import { buildGroupChatContext } from "../src/auto-reply/reply/groups.ts";

const before = buildGroupChatContext({
  sessionCtx: { Provider: "discord" },
  silentToken: "NO_REPLY",
  // silentReplyPolicy intentionally omitted — default / unset state
});
console.log("Contains silent guidance?", before.includes("Be extremely selective"));
console.log("Contains NO_REPLY?", before.includes("NO_REPLY"));
