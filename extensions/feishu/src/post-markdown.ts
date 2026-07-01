// Feishu post-message markdown helpers.

type MarkdownFence = {
  marker: "`" | "~";
  length: number;
};

function readOpeningMarkdownFence(line: string): MarkdownFence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  const fence = match?.[1];
  if (!fence) {
    return undefined;
  }
  return {
    marker: fence[0] as "`" | "~",
    length: fence.length,
  };
}

function isClosingMarkdownFence(line: string, activeFence: MarkdownFence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  const fence = match?.[1];
  return Boolean(fence && fence[0] === activeFence.marker && fence.length >= activeFence.length);
}

function isRawMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.indexOf("|", 1) > 0;
}

export function materializeFeishuPostMarkdownLineBreaks(text: string): string {
  const parts = text.split(/(\r\n|\n|\r)/);
  let activeFence: MarkdownFence | undefined;
  let result = "";
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? "";
    const separator = parts[index + 1] ?? "";
    const wasInFence = Boolean(activeFence);
    let isFenceBoundary = false;
    if (activeFence) {
      if (isClosingMarkdownFence(line, activeFence)) {
        activeFence = undefined;
        isFenceBoundary = true;
      }
    } else {
      activeFence = readOpeningMarkdownFence(line);
      isFenceBoundary = Boolean(activeFence);
    }
    result += line;
    if (!separator) {
      continue;
    }
    const nextLine = parts[index + 2] ?? "";
    const keepSingleBreak =
      wasInFence ||
      isFenceBoundary ||
      Boolean(readOpeningMarkdownFence(nextLine)) ||
      (isRawMarkdownTableRow(line) && isRawMarkdownTableRow(nextLine)) ||
      line.trim().length === 0 ||
      nextLine.trim().length === 0;
    result += keepSingleBreak ? separator : `${separator}${separator}`;
  }
  return result;
}
