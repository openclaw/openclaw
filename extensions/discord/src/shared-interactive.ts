import type { ChannelCapabilities } from "openclaw/plugin-sdk/channel-contract";
import {
  projectInteractiveReplyForCapabilities,
  reduceInteractiveReply,
} from "openclaw/plugin-sdk/interactive-runtime";
import type {
  InteractiveButtonStyle,
  InteractiveReply,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { DiscordComponentButtonStyle, DiscordComponentMessageSpec } from "./components.js";

function resolveDiscordInteractiveButtonStyle(
  style?: InteractiveButtonStyle,
): DiscordComponentButtonStyle | undefined {
  return style ?? "secondary";
}

const DISCORD_INTERACTIVE_BUTTON_ROW_SIZE = 5;

export function buildDiscordInteractiveComponents(
  interactive?: InteractiveReply,
  capabilities?: Pick<ChannelCapabilities, "richReplies"> | null,
): DiscordComponentMessageSpec | undefined {
  const projected = projectInteractiveReplyForCapabilities({
    interactive,
    capabilities: capabilities ?? {
      richReplies: {
        buttons: true,
        selects: true,
        commandFallback: true,
      },
    },
  }).interactive;
  const blocks = reduceInteractiveReply(
    projected,
    [] as NonNullable<DiscordComponentMessageSpec["blocks"]>,
    (state, block) => {
      if (block.type === "text") {
        const text = block.text.trim();
        if (text) {
          state.push({ type: "text", text });
        }
        return state;
      }
      if (block.type === "buttons") {
        if (block.buttons.length === 0) {
          return state;
        }
        for (
          let index = 0;
          index < block.buttons.length;
          index += DISCORD_INTERACTIVE_BUTTON_ROW_SIZE
        ) {
          state.push({
            type: "actions",
            buttons: block.buttons
              .slice(index, index + DISCORD_INTERACTIVE_BUTTON_ROW_SIZE)
              .map((button) => ({
                label: button.label,
                style: resolveDiscordInteractiveButtonStyle(button.style),
                callbackData: button.value,
              })),
          });
        }
        return state;
      }
      if (block.type === "select" && block.options.length > 0) {
        state.push({
          type: "actions",
          select: {
            type: "string",
            placeholder: block.placeholder,
            options: block.options.map((option) => ({
              label: option.label,
              value: option.value,
            })),
          },
        });
      }
      return state;
    },
  );
  return blocks.length > 0 ? { blocks } : undefined;
}
