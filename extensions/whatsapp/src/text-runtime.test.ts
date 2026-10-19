import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertWebChannel,
  jidToE164,
  markdownToWhatsApp,
  markdownToWhatsAppChunks,
  resolveEquivalentWhatsAppDirectChatJids,
  resolveJidToE164,
  toWhatsappJid,
  toWhatsappJidWithLid,
} from "./targets-runtime.js";

const tempDirs: string[] = [];
function tempDir(mappings: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-text-"));
  tempDirs.push(dir);
  for (const [key, value] of Object.entries(mappings)) {
    writeMapping(dir, key, value);
  }
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function writeMapping(dir: string, key: string, value: string) {
  fs.writeFileSync(path.join(dir, `lid-mapping-${key}.json`), JSON.stringify(value));
}

describe("WhatsApp text runtime", () => {
  it.each([
    ["*text*", "_text_"],
    ["", ""],
    ["`x`1 and `y`2", "```x```1 and ```y```2"],
    ["  indented", "  indented"],
    ["\uE0000\uE001 \uE0001\uE001 \uE002 \uE003", "\uE0000\uE001 \uE0001\uE001 \uE002 \uE003"],
  ] as const)("renders %j through the WhatsApp capability profile", (input, expected) => {
    expect(markdownToWhatsApp(input)).toBe(expected);
  });

  const table = "| Name | Value |\n| --- | --- |\n| A | 1 |";
  const codeTable = "```\n| Name | Value |\n| ---- | ----- |\n| A    | 1     |\n```";
  it.each([
    ["off", table],
    ["bullets", "*A*\n• Value: 1"],
    ["code", codeTable],
    ["block", codeTable],
  ] as const)("honors table mode %s", (mode, expected) => {
    expect(markdownToWhatsApp(table, mode)).toBe(expected);
  });

  it("closes and reopens formatting at chunk boundaries", () => {
    const chunks = markdownToWhatsAppChunks(`# ${"word ".repeat(12)}`, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
    expect(chunks.every((chunk) => /^\*.*\*\s*$/su.test(chunk))).toBe(true);
    expect(
      chunks.map((chunk) => chunk.replace(/^\*/u, "").replace(/\*(\s*)$/u, "$1")).join(""),
    ).toBe("word ".repeat(12));
  });

  it("keeps newline-mode paragraph packing for formatted text", () => {
    expect(
      markdownToWhatsAppChunks("**Alpha**\n\n**Beta**\n\n**Gamma**", 14, "bullets", "newline"),
    ).toEqual(["*Alpha*", "*Beta*", "*Gamma*"]);
  });

  it("applies the chunk limit to whitespace-only text", () => {
    expect(markdownToWhatsAppChunks(" ".repeat(12), 5)).toEqual(["    ", "    ", "  "]);
  });

  it("assertWebChannel rejects invalid channels", () => {
    expect(() => assertWebChannel("bad")).toThrow("Web channel must be 'web'");
  });
  it.each([
    ["whatsapp:+555 123 4567", "5551234567@s.whatsapp.net"],
    ["123456789-987654321@g.us", "123456789-987654321@g.us"],
    ["whatsapp:123456789-987654321@g.us", "123456789-987654321@g.us"],
    ["1555123@s.whatsapp.net", "1555123@s.whatsapp.net"],
  ])("toWhatsappJid normalizes %s", (input, expected) => {
    expect(toWhatsappJid(input)).toBe(expected);
  });
  it("jidToE164 maps @lid using reverse mapping file", async () => {
    const stateDir = tempDir();
    const credentialsDir = path.join(stateDir, "credentials");
    fs.mkdirSync(credentialsDir, { recursive: true });
    writeMapping(credentialsDir, "123_reverse", "5551234");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.resetModules();
    try {
      const { jidToE164: freshJidToE164 } = await import("./targets-runtime.js");
      expect(freshJidToE164("123@lid")).toBe("+5551234");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("jidToE164 falls back through lidMappingDirs in order", () => {
    const first = tempDir();
    const second = tempDir({ "321_reverse": "123321" });
    expect(jidToE164("321@lid", { lidMappingDirs: [first, second] })).toBe("+123321");
  });
  it.each([
    ["+15555550000", "987654@lid"],
    ["+33123456789", "33123456789@s.whatsapp.net"],
    ["123456789-987654321@g.us", "123456789-987654321@g.us"],
    ["1555123@s.whatsapp.net", "1555123@s.whatsapp.net"],
    ["999@lid", "999@lid"],
  ])("toWhatsappJidWithLid resolves %s (issue #67378)", (input, expected) => {
    const authDir = tempDir({ "15555550000": "987654" });
    expect(toWhatsappJidWithLid(input, { authDir })).toBe(expected);
  });
  it.each([
    ["777@lid", "777:0@s.whatsapp.net", "+777", false, 1],
    ["888@s.whatsapp.net", "888:0@s.whatsapp.net", "+888", false, 0],
    ["777@lid", "", null, true, 1],
  ] as const)("resolveJidToE164(%s) via %s", async (jid, pn, expected, fail, calls) => {
    const getPNForLID = vi.fn(async () => {
      if (fail) {
        throw new Error("lookup failed");
      }
      return pn;
    });
    await expect(resolveJidToE164(jid, { lidLookup: { getPNForLID } })).resolves.toBe(expected);
    expect(getPNForLID).toHaveBeenCalledTimes(calls);
    if (calls) {
      expect(getPNForLID).toHaveBeenCalledWith(jid);
    }
  });
  it.each([
    ["15551230000:0@s.whatsapp.net", "15551230000@s.whatsapp.net"],
    ["777:2@hosted.lid", "777@hosted.lid"],
  ])(
    "resolveEquivalentWhatsAppDirectChatJids includes the bare form for %s",
    async (observedJid, bareJid) => {
      await expect(resolveEquivalentWhatsAppDirectChatJids(observedJid)).resolves.toEqual([
        observedJid,
        bareJid,
      ]);
    },
  );

  it("preserves hosted direct-chat domains for local PN/LID mappings", async () => {
    const authDir = tempDir({ "15551230000": "777", "777_reverse": "15551230000" });

    await expect(
      resolveEquivalentWhatsAppDirectChatJids("15551230000@hosted", { authDir }),
    ).resolves.toEqual(["15551230000@hosted", "777@hosted.lid"]);
    await expect(
      resolveEquivalentWhatsAppDirectChatJids("777@hosted.lid", { authDir }),
    ).resolves.toEqual(["777@hosted.lid", "15551230000@hosted"]);
  });
});
