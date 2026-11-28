import { builtinThemeBrandingOverrides } from "./theme-builtin-branding.js";
import type { ThemeDescriptor } from "./theme.js";

export const BUILTIN_THEMES: readonly ThemeDescriptor[] = /* @__PURE__ */ (
  [
    {
      id: "claw",
      name: "Claw",
      description:
        "Signature coral red and teal on charcoal or pale surfaces, with Instrument Sans throughout. A balanced everyday workspace.",
    },
    {
      id: "knot",
      name: "Knot",
      description:
        "Crimson accents on true black or clean white, with Geist typography. Sharp, minimal, and high contrast.",
    },
    {
      id: "dash",
      name: "Dash",
      description:
        "Toasted caramel on deep cocoa or warm cream, with DM Sans controls and Fraunces serif chat. Warm and bookish.",
    },
    {
      id: "absolutely",
      name: "Absolutely",
      description:
        "Terracotta clay on warm graphite or soft cream, with Space Grotesk controls and Lora serif chat. Quiet editorial character.",
    },
    {
      id: "tide",
      name: "Tide",
      description:
        "Steel cyan on cool slate or pale blue-gray, with IBM Plex Sans throughout. Calm, technical, and understated.",
    },
    {
      id: "beacon",
      name: "Beacon",
      description:
        "High-visibility amber on black or white, bold focus rings, and Atkinson Hyperlegible typography. Designed for maximum readability.",
    },
    {
      id: "phosphor",
      name: "Phosphor",
      description:
        "Luminous green on green-tinted black or pale green, with JetBrains Mono throughout. A classic green terminal atmosphere.",
    },
    {
      id: "crt",
      name: "CRT",
      description:
        "White phosphor and amber on tube black, with a light counterpart, JetBrains Mono, and nearly square corners. A retro computer console.",
    },
    {
      id: "manuscript",
      name: "Manuscript",
      description:
        "Lapis blue and gold on aged paper, with a dark reading-room variant and Lora serif throughout. A quiet illuminated manuscript.",
    },
    {
      id: "rose",
      name: "Rosé",
      description:
        "Dried rose and gold on deep plum-gray or soft rose-tinted cream, with DM Sans. Gentle, muted, and warm.",
    },
    {
      id: "miami",
      name: "Miami",
      description:
        "Hot magenta and cyan on violet-black or pale lavender, with Space Grotesk. Bright neon energy and a synthwave character.",
    },
  ] satisfies Array<Omit<ThemeDescriptor, "source" | "modes">>
).map<ThemeDescriptor>((theme) =>
  Object.assign(theme, builtinThemeBrandingOverrides(theme.id), {
    source: "builtin",
    modes: ["light", "dark"],
  } satisfies Pick<ThemeDescriptor, "source" | "modes">),
);
