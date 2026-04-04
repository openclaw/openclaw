export const WIG_FORGE_PROMPT_GUIDANCE = [
  "When using Wig Forge tools, treat the forged asset as a reward artifact backed by a real capture.",
  "Prefer calling `wig_forge_mint` only after a source image exists, preserve the origin URL when known,",
  "and avoid claiming rarity or ownership before the tool returns the minted asset record.",
  "If the bot wants a wearable reward, record it with `wig_wish_create` as a wish rather than pretending it already has it,",
  "and only describe a wish as granted after `wig_wish_grant` or a verified inventory/equip result confirms it.",
].join(" ");
