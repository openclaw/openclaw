import { randomBytes } from "node:crypto";

const SLUG_ADJECTIVES = [
  "amber",
  "briny",
  "brisk",
  "calm",
  "clear",
  "cool",
  "crisp",
  "dawn",
  "delta",
  "ember",
  "faint",
  "fast",
  "fresh",
  "gentle",
  "glow",
  "good",
  "grand",
  "keen",
  "kind",
  "lucky",
  "marine",
  "mellow",
  "mild",
  "neat",
  "nimble",
  "nova",
  "oceanic",
  "plaid",
  "quick",
  "quiet",
  "rapid",
  "salty",
  "sharp",
  "swift",
  "tender",
  "tidal",
  "tidy",
  "tide",
  "vivid",
  "warm",
  "wild",
  "young",
];

const SLUG_NOUNS = [
  "atlas",
  "basil",
  "bison",
  "bloom",
  "breeze",
  "canyon",
  "cedar",
  "claw",
  "cloud",
  "comet",
  "coral",
  "cove",
  "crest",
  "crustacean",
  "daisy",
  "dune",
  "ember",
  "falcon",
  "fjord",
  "forest",
  "glade",
  "gulf",
  "harbor",
  "haven",
  "kelp",
  "lagoon",
  "lobster",
  "meadow",
  "mist",
  "nudibranch",
  "nexus",
  "ocean",
  "orbit",
  "otter",
  "pine",
  "prairie",
  "reef",
  "ridge",
  "river",
  "rook",
  "sable",
  "sage",
  "seaslug",
  "shell",
  "shoal",
  "shore",
  "slug",
  "summit",
  "tidepool",
  "trail",
  "valley",
  "wharf",
  "willow",
  "zephyr",
];

function secureRandomChoice(values: string[], fallback: string) {
  const randomIndex = randomBytes(4).readUInt32BE(0) % values.length;
  return values[randomIndex] ?? fallback;
}

function createSecureToken(length: number): string {
  return randomBytes(Math.ceil((length * 3) / 4))
    .toString("base64url")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, length);
}

function createSlugBase(words = 2) {
  const parts = [
    secureRandomChoice(SLUG_ADJECTIVES, "steady"),
    secureRandomChoice(SLUG_NOUNS, "harbor"),
  ];
  if (words > 2) {
    parts.push(secureRandomChoice(SLUG_NOUNS, "reef"));
  }
  return parts.join("-");
}

function createAvailableSlug(
  words: number,
  isIdTaken: (id: string) => boolean,
): string | undefined {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const base = createSlugBase(words);
    if (!isIdTaken(base)) {
      return base;
    }
    for (let i = 2; i <= 12; i += 1) {
      const candidate = `${base}-${i}`;
      if (!isIdTaken(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function createSessionSlug(isTaken?: (id: string) => boolean): string {
  const isIdTaken = isTaken ?? (() => false);
  const twoWord = createAvailableSlug(2, isIdTaken);
  if (twoWord) {
    return twoWord;
  }
  const threeWord = createAvailableSlug(3, isIdTaken);
  if (threeWord) {
    return threeWord;
  }
  const fallback = `${createSlugBase(3)}-${createSecureToken(5)}`;
  return isIdTaken(fallback) ? `${fallback}-${Date.now().toString(36)}` : fallback;
}
