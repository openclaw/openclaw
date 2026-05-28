import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { AUTOMATION_SYSTEM_PROMPT } from "../system-prompt.js";
import { peekUserMode } from "../telegram-ui/user-state.js";

type PromptBuildHookContext = {
  messageProvider?: unknown;
  channelId?: unknown;
};

function parseNumericChannelId(channelId: unknown): number | undefined {
  if (typeof channelId !== "string") {
    return undefined;
  }
  const match = channelId.trim().match(/-?\d+/);
  if (!match) {
    return undefined;
  }
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

function normalizeHookContext(input: unknown): PromptBuildHookContext {
  if (!input || typeof input !== "object") {
    return {};
  }
  const record = input as Record<string, unknown>;
  return {
    messageProvider: record["messageProvider"],
    channelId: record["channelId"],
  };
}

export function resolveTelegramModePrompt(input: PromptBuildHookContext): string | undefined {
  if (
    typeof input.messageProvider !== "string" ||
    input.messageProvider.toLowerCase() !== "telegram"
  ) {
    return undefined;
  }

  const userId = parseNumericChannelId(input.channelId);
  if (userId === undefined) {
    return undefined;
  }

  const mode = peekUserMode(userId);
  switch (mode) {
    case "code":
      return [
        "## Telegram 互動模式：寫碼模式",
        "使用者目前在 Telegram 寫碼模式。",
        "優先回覆可直接執行的程式修改、驗證命令、與下一個最小安全任務。",
      ].join("\n");
    case "chat":
      return [
        "## Telegram 互動模式：對話模式",
        "使用者目前在 Telegram 對話模式。",
        "回覆保持精簡直接，除非使用者明確要求，避免主動展開大型改造。",
      ].join("\n");
    case "workflow":
      return [
        "## Telegram 互動模式：工作流模式",
        "使用者目前在 Telegram 工作流模式。",
        "優先輸出本輪進度、阻塞點、與可立即執行的下一步。",
      ].join("\n");
    default:
      return undefined;
  }
}

export function registerPromptBuildHook(api: OpenClawPluginApi) {
  api.on(
    "before_prompt_build",
    async (_event: unknown, ctx: unknown) => {
      const modePrompt = resolveTelegramModePrompt(normalizeHookContext(ctx));
      return {
        appendSystemContext: modePrompt
          ? `${AUTOMATION_SYSTEM_PROMPT}\n\n${modePrompt}`
          : AUTOMATION_SYSTEM_PROMPT,
      };
    },
    { timeoutMs: 5_000 },
  );
}
