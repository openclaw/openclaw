import fs from "node:fs";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWhatsAppTargetFacts } from "./target-facts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    ["whatsapp:+1 (555) 123-0000", "+15551230000", "direct", "15551230000@s.whatsapp.net", true],
    ["15551230000@s.whatsapp.net", "+15551230000", "direct", "15551230000@s.whatsapp.net", true],
    [
      "whatsapp:120363401234567890@g.us",
      "120363401234567890@g.us",
      "group",
      "120363401234567890@g.us",
      true,
    ],
    [
      "WhatsApp:120363401234567890@NEWSLETTER",
      "120363401234567890@newsletter",
      "channel",
      "120363401234567890@newsletter",
      false,
    ],
  ] as const)("derives facts for %s", (target, normalizedTarget, chatType, jid, composing) => {
    expect(factsFor(target, ["+19999999999"])).toMatchObject({
      normalizedTarget,
      chatType,
      routePeer: { kind: chatType, id: normalizedTarget },
      wireDelivery: {
        jid,
        shouldSendComposingPresence: composing,
        preserveJidAsAuthorizedTarget: false,
      },
    });
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
      'Target "277038292303944@lid" is not listed in the configured WhatsApp allowFrom policy.',
    );
  });

  it("does not authorize an opaque LID through a phone-number allowFrom entry", () => {
    const blocked = factsFor("15551230000:4@lid", ["+15551230000"]).authorization;

    expect(blocked.allowed).toBe(false);
    expect(blocked.allowed ? "" : blocked.error.message).toBe(
      'Target "15551230000@lid" is not listed in the configured WhatsApp allowFrom policy.',
    );
  });

  it("bypasses direct allowFrom for groups and newsletters", () => {
    expect(factsFor("120363401234567890@g.us", ["+19999999999"]).authorization.allowed).toBe(true);
    expect(factsFor("120363401234567890@newsletter", ["+19999999999"]).authorization.allowed).toBe(
      true,
    );
  });

  it.each(["+15555550000", "15555550000@s.whatsapp.net", "15555550000@c.us"])(
    "maps %s to a LID with auth context",
    (target) => {
      const authDir = tempDirs.make("openclaw-wa-target-facts-");
      fs.writeFileSync(path.join(authDir, "lid-mapping-15555550000.json"), JSON.stringify(987654));
      const resolution = resolveWhatsAppTargetFacts({
        target,
        lidOptions: { authDir },
      });
      expect(resolution).toMatchObject({
        ok: true,
        facts: { wireDelivery: { jid: "987654@lid", shouldSendComposingPresence: true } },
      });
    },
  );

  it.each([
    ["device LID", "277038292303944:4@lid", "277038292303944@lid"],
    ["hosted LID", "789@hosted.lid", "789@hosted.lid"],
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
