import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWhatsAppTargetFacts } from "./target-facts.js";

async function withTempDir<T>(run: (dir: string) => T | Promise<T>): Promise<Awaited<T>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wa-target-facts-"));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function factsFor(target: string, allowFrom?: Array<string | number>) {
  const resolution = resolveWhatsAppTargetFacts({ target, allowFrom });
  expect(resolution.ok).toBe(true);
  if (!resolution.ok) {
    throw resolution.error;
  }
  return resolution.facts;
}

describe("resolveWhatsAppTargetFacts", () => {
  it.each([
    [
      "direct",
      "whatsapp:+1 (555) 123-0000",
      {
        normalizedTarget: "+15551230000",
        chatType: "direct",
        routePeer: { kind: "direct", id: "+15551230000" },
        wireDelivery: {
          jid: "15551230000@s.whatsapp.net",
          shouldSendComposingPresence: true,
        },
      },
    ],
    [
      "group",
      "whatsapp:120363401234567890@g.us",
      {
        normalizedTarget: "120363401234567890@g.us",
        chatType: "group",
        routePeer: { kind: "group", id: "120363401234567890@g.us" },
        wireDelivery: {
          jid: "120363401234567890@g.us",
          shouldSendComposingPresence: true,
        },
      },
    ],
    [
      "newsletter",
      "WhatsApp:120363401234567890@NEWSLETTER",
      {
        normalizedTarget: "120363401234567890@newsletter",
        chatType: "channel",
        routePeer: { kind: "channel", id: "120363401234567890@newsletter" },
        wireDelivery: {
          jid: "120363401234567890@newsletter",
          shouldSendComposingPresence: false,
        },
      },
    ],
  ] as const)("derives %s target facts", (_name, target, expected) => {
    expect(factsFor(target, ["+19999999999"])).toMatchObject(expected);
  });

  it("keeps direct allowFrom semantics", () => {
    expect(factsFor("+15551230000", ["*"]).authorization.allowed).toBe(true);
    expect(factsFor("+15551230000", []).authorization.allowed).toBe(true);
    expect(factsFor("+15551230000", ["+15551230000"]).authorization.allowed).toBe(true);

    const blocked = factsFor("+15551230000", ["+19999999999"]).authorization;
    expect(blocked.allowed).toBe(false);
    expect(blocked.allowed ? "" : blocked.error.message).toBe(
      'Target "+15551230000" is not listed in the configured WhatsApp allowFrom policy.',
    );
  });

  it("uses formed direct JIDs in allowFrom checks", () => {
    expect(
      factsFor("whatsapp:277038292303944:4@lid", ["277038292303944:4@lid"]).authorization.allowed,
    ).toBe(true);

    const blocked = factsFor("whatsapp:277038292303944:4@lid", ["789@hosted.lid"]).authorization;
    expect(blocked.allowed).toBe(false);
    expect(blocked.allowed ? "" : blocked.error.message).toBe(
      'Target "+277038292303944" is not listed in the configured WhatsApp allowFrom policy.',
    );
  });

  it("bypasses direct allowFrom for groups and newsletters", () => {
    expect(factsFor("120363401234567890@g.us", ["+19999999999"]).authorization.allowed).toBe(true);
    expect(factsFor("120363401234567890@newsletter", ["+19999999999"]).authorization.allowed).toBe(
      true,
    );
  });

  it("uses LID forward mappings when auth context is available", async () => {
    await withTempDir((authDir) => {
      fs.writeFileSync(path.join(authDir, "lid-mapping-15555550000.json"), JSON.stringify(987654));
      const resolution = resolveWhatsAppTargetFacts({
        target: "+15555550000",
        lidOptions: { authDir },
      });
      expect(resolution).toMatchObject({
        ok: true,
        facts: { wireDelivery: { jid: "987654@lid", shouldSendComposingPresence: true } },
      });
    });
  });

  it.each([
    ["device LID", "277038292303944:4@lid", "+277038292303944"],
    ["hosted LID", "789@hosted.lid", "+789"],
    ["hosted PN", "1555000:2@hosted", "+1555000"],
  ] as const)("accepts formed direct %s JIDs", (_name, target, normalizedTarget) => {
    expect(factsFor(`whatsapp:${target}`, [normalizedTarget])).toMatchObject({
      normalizedTarget,
      chatType: "direct",
      routePeer: { kind: "direct", id: normalizedTarget },
      authorization: { allowed: true },
      wireDelivery: {
        jid: target,
        shouldSendComposingPresence: true,
      },
    });
  });

  it("returns errors for missing and invalid targets", () => {
    expect(resolveWhatsAppTargetFacts({ target: " " })).toMatchObject({
      ok: false,
    });
    expect(resolveWhatsAppTargetFacts({ target: "telegram:15551230000" })).toMatchObject({
      ok: false,
    });
  });
});
