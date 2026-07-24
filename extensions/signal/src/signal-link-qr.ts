import { renderQrTerminal } from "openclaw/plugin-sdk/media-runtime";

const ANSI_SGR = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");
const SOURCE_QUIET_ZONE_MODULES = 1;
const SIGNAL_LINK_QUIET_ZONE_MODULES = 4;
const BLACK_BACKGROUND_WHITE_FOREGROUND = "\x1b[48;2;0;0;0m\x1b[38;2;255;255;255m";
const TERMINAL_RESET = "\x1b[0m";

function decodeCompactBlock(char: string): [boolean, boolean] {
  if (char === "█") {
    return [true, true];
  }
  if (char === "▀") {
    return [true, false];
  }
  if (char === "▄") {
    return [false, true];
  }
  if (char === " ") {
    return [false, false];
  }
  throw new Error(`Unexpected compact QR character: ${char}`);
}

function renderHighContrastBlock(topDark: boolean, bottomDark: boolean): string {
  if (topDark && bottomDark) {
    return " ";
  }
  if (topDark) {
    return "▄";
  }
  if (bottomDark) {
    return "▀";
  }
  return "█";
}

export async function renderSignalLinkQr(uri: string): Promise<string> {
  const compact = await renderQrTerminal(uri, { small: true });
  const sourceLines = compact
    .split(/\r?\n/)
    .map((line) => Array.from(line.replace(ANSI_SGR, ""), decodeCompactBlock));
  const qrSize = (sourceLines[0]?.length ?? 0) - SOURCE_QUIET_ZONE_MODULES * 2;
  const sourceWidth = qrSize + SOURCE_QUIET_ZONE_MODULES * 2;
  if (qrSize <= 0 || sourceLines.some((line) => line.length !== sourceWidth)) {
    throw new Error("Unexpected compact QR dimensions");
  }
  const sourceRows = sourceLines.flatMap((line) => [
    line.map(([top]) => top),
    line.map(([, bottom]) => bottom),
  ]);
  const symbolSize = qrSize + SIGNAL_LINK_QUIET_ZONE_MODULES * 2;
  const output: string[] = [];

  // Truecolor escapes avoid terminal palette remapping. Repacking also restores the
  // four-module quiet zone that scanners require without using oversized full mode.
  for (let y = 0; y < symbolSize; y += 2) {
    let line = BLACK_BACKGROUND_WHITE_FOREGROUND;
    for (let x = 0; x < symbolSize; x += 1) {
      const moduleX = x - SIGNAL_LINK_QUIET_ZONE_MODULES;
      const topModuleY = y - SIGNAL_LINK_QUIET_ZONE_MODULES;
      const sourceX = moduleX + SOURCE_QUIET_ZONE_MODULES;
      const topSourceY = topModuleY + SOURCE_QUIET_ZONE_MODULES;
      const topDark =
        moduleX >= 0 &&
        moduleX < qrSize &&
        topModuleY >= 0 &&
        topModuleY < qrSize &&
        (sourceRows[topSourceY]?.[sourceX] ?? false);
      const bottomModuleY = topModuleY + 1;
      const bottomSourceY = topSourceY + 1;
      const bottomDark =
        moduleX >= 0 &&
        moduleX < qrSize &&
        bottomModuleY >= 0 &&
        bottomModuleY < qrSize &&
        (sourceRows[bottomSourceY]?.[sourceX] ?? false);
      line += renderHighContrastBlock(topDark, bottomDark);
    }
    output.push(`${line}${TERMINAL_RESET}`);
  }
  return output.join("\n");
}
