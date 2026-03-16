import type { InteractiveButtonStyle, InteractiveReply } from "../../../src/interactive/payload.js";
import type { DiscordComponentButtonStyle, DiscordComponentMessageSpec } from "./components.js";

function resolveDiscordButtonStyle(
  style?: InteractiveButtonStyle,
): DiscordComponentButtonStyle | undefined {
  return style ?? "secondary";
}

export function buildDiscordInteractiveComponents(
  interactive?: InteractiveReply,
): DiscordComponentMessageSpec | undefined {
  const blocks: NonNullable<DiscordComponentMessageSpec["blocks"]> = [];
  for (const block of interactive?.blocks ?? []) {
    if (block.type === "buttons") {
      if (block.buttons.length === 0) {
        continue;
      }
      blocks.push({
        type: "actions",
        buttons: block.buttons.map((button) => ({
          label: button.label,
          style: resolveDiscordButtonStyle(button.style),
          callbackData: button.value,
        })),
      });
      continue;
    }
    if (block.type === "select" && block.options.length > 0) {
      blocks.push({
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
  }
  return blocks.length > 0 ? { blocks } : undefined;
}
