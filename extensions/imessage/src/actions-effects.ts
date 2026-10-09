import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

const EFFECT_ALIASES: Record<string, string> = {
  slam: "com.apple.MobileSMS.expressivesend.impact",
  impact: "com.apple.MobileSMS.expressivesend.impact",
  loud: "com.apple.MobileSMS.expressivesend.loud",
  gentle: "com.apple.MobileSMS.expressivesend.gentle",
  "invisible-ink": "com.apple.MobileSMS.expressivesend.invisibleink",
  invisibleink: "com.apple.MobileSMS.expressivesend.invisibleink",
  confetti: "com.apple.MobileSMS.expressivesend.confetti",
  lasers: "com.apple.MobileSMS.expressivesend.lasers",
  fireworks: "com.apple.MobileSMS.expressivesend.fireworks",
  balloons: "com.apple.MobileSMS.expressivesend.balloon",
  balloon: "com.apple.MobileSMS.expressivesend.balloon",
  heart: "com.apple.MobileSMS.expressivesend.heart",
  echo: "com.apple.messages.effect.CKEchoEffect",
  happybirthday: "com.apple.messages.effect.CKHappyBirthdayEffect",
  "happy-birthday": "com.apple.messages.effect.CKHappyBirthdayEffect",
  shootingstar: "com.apple.messages.effect.CKShootingStarEffect",
  "shooting-star": "com.apple.messages.effect.CKShootingStarEffect",
  sparkles: "com.apple.messages.effect.CKSparklesEffect",
  spotlight: "com.apple.messages.effect.CKSpotlightEffect",
};
const KNOWN_EFFECT_IDS = new Set(Object.values(EFFECT_ALIASES));

export function effectIdFromParam(raw?: string): string | undefined {
  const value = normalizeOptionalLowercaseString(raw);
  if (!value) {
    return undefined;
  }
  const resolved = EFFECT_ALIASES[value] ?? raw;
  if (typeof resolved === "string" && KNOWN_EFFECT_IDS.has(resolved)) {
    return resolved;
  }
  throw new Error(
    `iMessage sendWithEffect rejected unknown effect "${raw}". ` +
      "Use one of: slam, loud, gentle, invisibleink, confetti, lasers, fireworks, balloon, heart, " +
      "echo, happybirthday, shootingstar, sparkles, spotlight (or the canonical com.apple.MobileSMS.expressivesend.* / com.apple.messages.effect.* identifier).",
  );
}
