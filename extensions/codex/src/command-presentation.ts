import {
  renderMessagePresentationFallbackText,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";

export type CodexCommandPickerButton = { label: string; command: string };

export function buildCodexPresentationReply(
  presentation: MessagePresentation,
): PluginCommandResult {
  return {
    text: renderMessagePresentationFallbackText({ presentation }),
    presentation,
    presentationTextMode: "fallback",
  };
}

export function buildCodexCommandPickerPresentation(
  title: string,
  prompt: string,
  buttons: CodexCommandPickerButton[],
): MessagePresentation {
  return {
    title,
    blocks: [
      { type: "text", text: prompt },
      {
        type: "buttons",
        buttons: buttons.map((button) => ({
          label: button.label,
          action: { type: "command", command: button.command },
        })),
      },
    ],
  };
}
