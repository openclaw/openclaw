import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import { renderSignalLinkQr } from "./signal-link-qr.js";

const ANSI_SGR = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");
const QR_MARGIN_MODULES = 1;

function visibleLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(ANSI_SGR, ""))
    .filter((line) => line.length > 0);
}

function decodeSignalLinkBlock(char: string): [boolean, boolean] {
  if (char === " ") {
    return [true, true];
  }
  if (char === "▄") {
    return [true, false];
  }
  if (char === "▀") {
    return [false, true];
  }
  if (char === "█") {
    return [false, false];
  }
  throw new Error(`Unexpected Signal QR character: ${char}`);
}

function decodeSignalLinkQr(output: string, size: number): boolean[] {
  const decoded = Array.from({ length: size * size }, () => false);
  visibleLines(output).forEach((line, lineIndex) => {
    Array.from(line).forEach((char, columnIndex) => {
      const x = columnIndex - QR_MARGIN_MODULES;
      const topY = lineIndex * 2 - QR_MARGIN_MODULES;
      const [top, bottom] = decodeSignalLinkBlock(char);
      for (const [y, value] of [
        [topY, top],
        [topY + 1, bottom],
      ] as const) {
        if (x >= 0 && x < size && y >= 0 && y < size) {
          decoded[y * size + x] = value;
        }
      }
    });
  });
  return decoded;
}

describe("renderSignalLinkQr", () => {
  it("renders a compact black-on-white QR matrix without black foreground ANSI", async () => {
    const uri = "sgnl://linkdevice?uuid=test&pub_key=test";
    const qr = QRCode.create(uri);

    const rendered = await renderSignalLinkQr(uri);

    expect(rendered).not.toContain("\x1b[30m");
    expect(rendered).not.toContain("\x1b[47m");
    expect(rendered).toContain("\x1b[40m\x1b[37m");
    expect(visibleLines(rendered)[0]?.length).toBe(qr.modules.size + QR_MARGIN_MODULES * 2);
    expect(visibleLines(rendered)).toHaveLength(
      Math.ceil((qr.modules.size + QR_MARGIN_MODULES * 2) / 2),
    );
    expect(decodeSignalLinkQr(rendered, qr.modules.size)).toEqual(
      Array.from(qr.modules.data, Boolean),
    );
  });
});
