import { randomUUID, getRandomValues } from "crypto";

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

function randomChoice(values: string[], fallback: string) {
  // Use cryptographically secure random with rejection sampling to avoid modulo bias
  const maxUnbiased = Math.floor(0xffffffff / values.length) * values.length;
  let randomValue;

  do {
    const array = new Uint32Array(1);
    getRandomValues(array);
    randomValue = array[0];
  } while (randomValue >= maxUnbiased);

  const randomIndex = randomValue % values.length;
  return values[randomIndex] ?? fallback;
}

function createSlugBase(words = 2) {
  const parts = [randomChoice(SLUG_ADJECTIVES, "steady"), randomChoice(SLUG_NOUNS, "harbor")];
  if (words > 2) {
    parts.push(randomChoice(SLUG_NOUNS, "reef"));
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
  // Use cryptographically secure random for fallback slug with 3-character suffix to maintain format compatibility
  const fallback = `${createSlugBase(3)}-${randomUUID().replace(/-/g, "").slice(0, 3)}`;
  return isIdTaken(fallback) ? `${fallback}-${Date.now().toString(36).slice(0, 3)}` : fallback;
}
