import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import { renderSignalLinkQr } from "./signal-link-qr.js";

const TERMINAL_TOKEN = new RegExp(
  `${String.fromCharCode(0x1b)}\\[(?:(?:(38|48);2;(\\d+);(\\d+);(\\d+))|(0))m|([ ▀])`,
  "g",
);
const QR_QUIET_ZONE_MODULES = 4;

function decodeColor(red: string, green: string, blue: string): boolean {
  if (red === "0" && green === "0" && blue === "0") {
    return true;
  }
  if (red === "255" && green === "255" && blue === "255") {
    return false;
  }
  throw new Error(`Unexpected Signal QR color: ${red};${green};${blue}`);
}

function decodeSignalLinkLine(line: string): Array<[boolean, boolean]> {
  let foregroundDark: boolean | undefined;
  let backgroundDark: boolean | undefined;
  let offset = 0;
  const blocks: Array<[boolean, boolean]> = [];
  for (const match of line.matchAll(TERMINAL_TOKEN)) {
    if (match.index !== offset) {
      throw new Error(`Unexpected Signal QR terminal output at offset ${offset}`);
    }
    offset += match[0].length;
    const [, target, red, green, blue, reset, char] = match;
    if (reset) {
      foregroundDark = undefined;
      backgroundDark = undefined;
      continue;
    }
    if (target && red && green && blue) {
      const dark = decodeColor(red, green, blue);
      if (target === "38") {
        foregroundDark = dark;
      } else {
        backgroundDark = dark;
      }
      continue;
    }
    if (char === " " && backgroundDark !== undefined) {
      blocks.push([backgroundDark, backgroundDark]);
      continue;
    }
    if (char === "▀" && foregroundDark !== undefined && backgroundDark !== undefined) {
      blocks.push([foregroundDark, backgroundDark]);
      continue;
    }
    throw new Error("Signal QR cell is missing a truecolor foreground or background");
  }
  if (offset !== line.length) {
    throw new Error(`Unexpected Signal QR terminal output at offset ${offset}`);
  }
  return blocks;
}

function decodeSignalLinkQr(output: string): boolean[][] {
  return output.split(/\r?\n/).flatMap((line) => {
    const blocks = decodeSignalLinkLine(line);
    return [blocks.map(([top]) => top), blocks.map(([, bottom]) => bottom)];
  });
}

describe("renderSignalLinkQr", () => {
  it("renders a compact high-contrast QR matrix with a scanner-safe quiet zone", async () => {
    const uri = "sgnl://linkdevice?uuid=test&pub_key=test";
    const qr = QRCode.create(uri);
    const symbolSize = qr.modules.size + QR_QUIET_ZONE_MODULES * 2;

    const rendered = await renderSignalLinkQr(uri);
    const decoded = decodeSignalLinkQr(rendered);

    expect(rendered).not.toContain("\x1b[30m");
    expect(rendered).not.toContain("\x1b[47m");
    expect(rendered).not.toContain("█");
    expect(rendered).not.toContain("▄");
    expect(decoded[0]).toHaveLength(symbolSize);
    expect(decoded).toHaveLength(Math.ceil(symbolSize / 2) * 2);
    decoded.forEach((row, y) => {
      row.forEach((dark, x) => {
        const moduleX = x - QR_QUIET_ZONE_MODULES;
        const moduleY = y - QR_QUIET_ZONE_MODULES;
        const expected =
          moduleX >= 0 && moduleX < qr.modules.size && moduleY >= 0 && moduleY < qr.modules.size
            ? Boolean(qr.modules.data[moduleY * qr.modules.size + moduleX])
            : false;
        expect(dark).toBe(expected);
      });
    });
  });
});
