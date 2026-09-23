import { readStringParam } from "openclaw/plugin-sdk/channel-actions";
import {
  renderMessagePresentationFallbackText,
  resolveMessagePresentationButtonAction,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import { escapeTelegramCopyTextFallback, type TelegramDroppedControl } from "./button-types.js";
import { resolveTelegramInteractiveTextFallback } from "./interactive-fallback.js";

export type TelegramActionDroppedControl = TelegramDroppedControl & { fallbackText?: string };

export function hydrateTelegramDroppedControlFallbacks(
  controls: TelegramActionDroppedControl[],
  presentation: MessagePresentation | undefined,
): void {
  const copyButtons =
    presentation?.blocks.flatMap((block) =>
      block.type === "buttons"
        ? block.buttons.filter(
            (button) => resolveMessagePresentationButtonAction(button)?.type === "copy-text",
          )
        : [],
    ) ?? [];
  const used = new Set<number>();
  for (const control of controls) {
    if (
      control.reason !== "copy_text_invalid" &&
      control.reason !== "presentation_action_budget_exceeded" &&
      control.reason !== "presentation_keyboard_precedence"
    ) {
      continue;
    }
    const index = copyButtons.findIndex(
      (button, candidateIndex) => !used.has(candidateIndex) && button.label === control.label,
    );
    if (index < 0) {
      continue;
    }
    const copyButton = copyButtons[index];
    if (!copyButton) {
      continue;
    }
    const action = resolveMessagePresentationButtonAction(copyButton);
    if (action?.type === "copy-text") {
      used.add(index);
      control.fallbackText = escapeTelegramCopyTextFallback(action.text);
    }
  }
}

export function appendTelegramActionDroppedControlFallback(
  text: string,
  controls: readonly TelegramActionDroppedControl[],
): string {
  const fallback = renderMessagePresentationFallbackText({
    presentation: {
      blocks: [
        {
          type: "buttons",
          buttons: controls.map((control) =>
            control.fallbackText === undefined
              ? { label: control.label, value: "unavailable" }
              : {
                  label: control.label,
                  action: { type: "copy-text" as const, text: control.fallbackText },
                },
          ),
        },
      ],
    },
  });
  if (!fallback || text === fallback || text.endsWith(`\n\n${fallback}`)) {
    return text;
  }
  return [text, fallback].filter(Boolean).join("\n\n");
}

export function renderTelegramActionPresentationText(
  presentation: MessagePresentation | undefined,
): string {
  if (!presentation) {
    return "";
  }
  return renderMessagePresentationFallbackText({
    presentation: {
      ...presentation,
      blocks: presentation.blocks.filter(
        (block) => block.type !== "buttons" && block.type !== "select",
      ),
    },
  });
}

export function readTelegramSendContent(params: {
  args: Record<string, unknown>;
  mediaUrl?: string;
  hasButtons: boolean;
  hasDroppedControls?: boolean;
  hasLocation?: boolean;
  interactive?: unknown;
  presentation?: MessagePresentation;
}) {
  const explicitContent =
    readStringParam(params.args, "content", { allowEmpty: true }) ??
    readStringParam(params.args, "message", { allowEmpty: true }) ??
    readStringParam(params.args, "caption", { allowEmpty: true });
  const visibleBlocks =
    params.presentation?.blocks.filter(
      (block) => block.type !== "buttons" && block.type !== "select",
    ) ?? [];
  const presentationText =
    explicitContent == null
      ? renderTelegramActionPresentationText(params.presentation)
      : visibleBlocks.some((block) => block.type === "chart" || block.type === "table")
        ? renderMessagePresentationFallbackText({
            text: explicitContent,
            presentation: {
              ...params.presentation,
              blocks: visibleBlocks.filter(
                (block) => block.type === "chart" || block.type === "table",
              ),
            },
          })
        : undefined;
  const interactiveText =
    explicitContent == null && !params.presentation
      ? resolveTelegramInteractiveTextFallback({ interactive: params.interactive })
      : undefined;
  let content =
    (presentationText?.trim() ? presentationText : undefined) ??
    explicitContent ??
    (interactiveText?.trim() ? interactiveText : undefined);
  if ((content == null || content.trim().length === 0) && !params.mediaUrl && params.hasButtons) {
    const fallback = presentationText?.trim() ? presentationText : interactiveText;
    content = fallback?.trim() ? fallback : "Choose an option.";
  }
  if (
    content == null &&
    !params.mediaUrl &&
    !params.hasButtons &&
    !params.hasDroppedControls &&
    !params.hasLocation
  ) {
    throw new Error("content required.");
  }
  return {
    content: content ?? "",
    hasExplicitContent: explicitContent != null,
  };
}
