import { handleSlackMessageAction as handleSlackMessageActionImpl } from "openclaw/plugin-sdk/slack";

type HandleSlackMessageAction = typeof import("openclaw/plugin-sdk/slack").handleSlackMessageAction;

export async function handleSlackMessageAction(
  ...args: Parameters<HandleSlackMessageAction>
): ReturnType<HandleSlackMessageAction> {
  return await handleSlackMessageActionImpl(...args);
}
