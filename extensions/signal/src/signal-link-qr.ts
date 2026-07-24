import { renderQrTerminal } from "openclaw/plugin-sdk/media-runtime";

const ANSI_SGR = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");
const BLACK_BACKGROUND_WHITE_FOREGROUND = "\x1b[40m\x1b[37m";
const TERMINAL_RESET = "\x1b[0m";
const SIGNAL_LINK_BLOCKS: Record<string, string> = {
  " ": "█",
  "▄": "▀",
  "▀": "▄",
  "█": " ",
};

export async function renderSignalLinkQr(uri: string): Promise<string> {
  const compact = await renderQrTerminal(uri, { small: true });
  // Some embedded terminals remap black foreground. Inverting both the compact glyphs
  // and ANSI colors preserves a black-on-white QR without falling back to oversized full mode.
  return compact
    .split(/\r?\n/)
    .map((line) => {
      const visible = line.replace(ANSI_SGR, "");
      const inverted = Array.from(visible, (char) => {
        const block = SIGNAL_LINK_BLOCKS[char];
        if (block === undefined) {
          throw new Error(`Unexpected compact QR character: ${char}`);
        }
        return block;
      }).join("");
      return `${BLACK_BACKGROUND_WHITE_FOREGROUND}${inverted}${TERMINAL_RESET}`;
    })
    .join("\n");
}
