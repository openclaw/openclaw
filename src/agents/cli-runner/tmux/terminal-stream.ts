const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /(?:\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~]|\x1B[()][A-Za-z0-9]|\r)/g;

const UI_LINE_RE = /(?:^\s*[╭╰│].*$|^\s*[✻✢✶✽✺✹✸✷].*$|^\s*(?:esc|ctrl|shift)\b.*$|^\s*>?\s*$)/i;

export function stripTerminalControls(input: string): string {
  return input.replace(ANSI_RE, "");
}

export function normalizeTerminalAssistantText(input: string): string {
  const stripped = stripTerminalControls(input);
  return stripped
    .split("\n")
    .filter((line) => !UI_LINE_RE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

export class TerminalDeltaTracker {
  private text = "";

  push(chunk: string): string {
    const normalized = normalizeTerminalAssistantText(chunk);
    if (!normalized) {
      return "";
    }
    if (normalized.startsWith(this.text)) {
      const delta = normalized.slice(this.text.length);
      this.text = normalized;
      return delta;
    }
    if (this.text.endsWith(normalized)) {
      return "";
    }
    this.text += normalized;
    return normalized;
  }

  getText(): string {
    return this.text.trim();
  }
}
