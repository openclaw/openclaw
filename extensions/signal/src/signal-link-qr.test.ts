import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import { renderSignalLinkQr } from "./signal-link-qr.js";

const ANSI_SGR = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");
const QR_QUIET_ZONE_MODULES = 4;
const SIGNAL_LINK_COLORS = "\x1b[48;2;0;0;0m\x1b[38;2;255;255;255m";

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

function decodeSignalLinkQr(output: string): boolean[][] {
  return visibleLines(output).flatMap((line) => {
    const blocks = Array.from(line, decodeSignalLinkBlock);
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
    expect(rendered).toContain(SIGNAL_LINK_COLORS);
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
