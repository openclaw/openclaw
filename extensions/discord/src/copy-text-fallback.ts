import {
  resolveMessagePresentationButtonAction,
  type MessagePresentation,
  type MessagePresentationBlock,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";

const DISCORD_MENTION_PATTERN = /@(?:everyone|here)\b|<@!?\d+>|<@&\d+>/iu;

function longestRun(value: string, character: "`" | "~"): number {
  const matches = value.match(character === "`" ? /`+/gu : /~+/gu);
  return Math.max(0, ...(matches ?? []).map((match) => match.length));
}

function chooseFence(value: string): string {
  const backticks = Math.max(3, longestRun(value, "`") + 1);
  const tildes = Math.max(3, longestRun(value, "~") + 1);
  return backticks <= tildes ? "`".repeat(backticks) : "~".repeat(tildes);
}

function truncateLabel(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  return characters.length <= maxCharacters
    ? value
    : `${characters.slice(0, Math.max(1, maxCharacters - 1)).join("")}…`;
}

function frameCopyText(params: {
  label: string;
  text: string;
  continued: boolean;
  maxCharacters: number;
}): string {
  const fence = chooseFence(params.text);
  const suffix = params.continued ? " (continued)" : "";
  const label = truncateLabel(params.label, Math.max(1, params.maxCharacters - 64));
  return `Actions:\n- ${label}${suffix}:\n${fence}\n${params.text}\n${fence}`;
}

function splitDiscordCopyTextFallback(params: {
  button: MessagePresentationButton;
  text: string;
  maxCharacters: number;
}): Array<Extract<MessagePresentationBlock, { type: "context" }>> {
  const characters = Array.from(params.text);
  const blocks: Array<Extract<MessagePresentationBlock, { type: "context" }>> = [];
  let offset = 0;
  while (offset < characters.length) {
    const continued = offset > 0;
    let low = offset + 1;
    let high = characters.length;
    let accepted = offset;
    while (low <= high) {
      const end = Math.floor((low + high) / 2);
      const framed = frameCopyText({
        label: params.button.label,
        text: characters.slice(offset, end).join(""),
        continued,
        maxCharacters: params.maxCharacters,
      });
      if (Array.from(framed).length <= params.maxCharacters) {
        accepted = end;
        low = end + 1;
      } else {
        high = end - 1;
      }
    }
    if (accepted === offset) {
      throw new Error("Discord copy-text fallback cannot fit one character in a text block");
    }
    blocks.push({
      type: "context",
      text: frameCopyText({
        label: params.button.label,
        text: characters.slice(offset, accepted).join(""),
        continued,
        maxCharacters: params.maxCharacters,
      }),
    });
    offset = accepted;
  }
  return blocks;
}

function flushButtons(
  blocks: MessagePresentationBlock[],
  buttons: MessagePresentationButton[],
): void {
  if (buttons.length > 0) {
    blocks.push({ type: "buttons", buttons: [...buttons] });
    buttons.length = 0;
  }
}

/** Replace Discord-unsupported copy controls with independently safe, bounded code blocks. */
export function prepareDiscordCopyTextFallbacks(params: {
  presentation: MessagePresentation;
  maxCharacters: number;
}): { presentation: MessagePresentation; changed: boolean; suppressMentions: boolean } {
  let changed = false;
  const fallbackTexts: string[] = [];
  const blocks = params.presentation.blocks.flatMap((block): MessagePresentationBlock[] => {
    if (block.type !== "buttons") {
      return [block];
    }
    const replacement: MessagePresentationBlock[] = [];
    const buttons: MessagePresentationButton[] = [];
    for (const button of block.buttons) {
      const action = resolveMessagePresentationButtonAction(button);
      if (action?.type !== "copy-text") {
        buttons.push(button);
        continue;
      }
      changed = true;
      flushButtons(replacement, buttons);
      if (button.disabled === true) {
        const text = `Actions:\n- ${button.label}`;
        fallbackTexts.push(text);
        replacement.push({ type: "context", text });
        continue;
      }
      const fallback = splitDiscordCopyTextFallback({
        button,
        text: action.text,
        maxCharacters: params.maxCharacters,
      });
      fallbackTexts.push(...fallback.map((entry) => entry.text));
      replacement.push(...fallback);
    }
    flushButtons(replacement, buttons);
    return replacement;
  });
  return {
    presentation: changed ? { ...params.presentation, blocks } : params.presentation,
    changed,
    suppressMentions: fallbackTexts.some((text) => DISCORD_MENTION_PATTERN.test(text)),
  };
}
