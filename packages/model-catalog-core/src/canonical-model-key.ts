// Host-independent model identity for the curated recommended-models list.
// A canonical key is lowercase and vendor-less, with a dotted version and no
// release date, effort level or serving variant, so every host's id for the
// same model maps to the same list entry.

const BEDROCK_REGION_PREFIX = /^(us|eu|apac|global|jp|au|ca|us-gov)\./;
const BEDROCK_VENDOR_PREFIX = /^([a-z][a-z0-9-]*)\.(?=[a-z])/;
const BEDROCK_VERSION_SUFFIX = /(-v\d+)?(:\d+)?$|-\d+:\d+$/;
// Ollama size tags name a distinct model (qwen3.8:27b), unlike :free or :latest.
const SIZE_TAG = /^e?\d+(\.\d+)?[bm](-a\d+(\.\d+)?[bm])?(?![a-z])/;
const VENDOR_PREFIX =
  /^(zai-org|z-ai|zai|x-ai|xai|openai|anthropic|google|moonshotai|deepseek-ai|mistralai)-(?=[a-z])/;
// Release dates (-20251101, Vertex @20251101), MMDD revisions (-0731) and
// Mistral-style YYMM revisions (-2604).
const DATE_SUFFIX =
  /[-@](\d{4}-?\d{2}-?\d{2}|\d{6}|(0[1-9]|1[0-2])-?(0[1-9]|[12]\d|3[01])|[23]\d(0[1-9]|1[0-2]))$/;
// Host serving variants fold into the base model: -fast, -highspeed, -tee, ...
const SERVING_SUFFIX = /-(tee|fp8|fp4|free|batch|fast-api|fast|highspeed|contributor|it)$/;
const VERSION_TOKEN = /^([a-z]*)(\d+(?:\.\d+)*)$/;
// Real ids and names are far shorter. Several passes below rescan their input,
// so the bound caps their work on malformed upstream strings; longer input has no key.
const MAX_KEY_INPUT_LENGTH = 256;

/**
 * Maps a provider model id or Arena display name to its canonical key, e.g.
 * `us.anthropic.claude-opus-4-5-20251101-v1:0` -> `claude-opus-4.5`,
 * `accounts/fireworks/models/glm-5p3` -> `glm-5.3`, `qwen3.8:27b` -> `qwen3.8-27b`,
 * `GPT 5.6 Sol (xHigh)` -> `gpt-5.6-sol`. Dated aliases carry their version only
 * in the display name: `mistral-medium-2604` named `Mistral Medium 3.5` ->
 * `mistral-medium-3.5`.
 */
export function canonicalModelKey(modelId: string, displayName?: string): string {
  const key = keyOf(modelId);
  if (displayName === undefined) {
    return key;
  }
  const named = keyOf(displayName);
  const family = canonicalModelFamily(key);
  const namedFamily = canonicalModelFamily(named);
  return family.version.length === 0 &&
    namedFamily.version.length > 0 &&
    family.name === namedFamily.name
    ? named
    : key;
}

function keyOf(text: string): string {
  if (text.length > MAX_KEY_INPUT_LENGTH) {
    return "";
  }
  let key = text
    .trim()
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/^~+/, "")
    .replace(BEDROCK_REGION_PREFIX, "");
  const bedrock = key.includes("/") ? null : BEDROCK_VENDOR_PREFIX.exec(key);
  if (bedrock) {
    key = key.slice(bedrock[0].length).replace(BEDROCK_VERSION_SUFFIX, "");
    // Bedrock ids without a model name prefix keep their vendor: deepseek.r1 -> deepseek-r1.
    if (/^[a-z]\d/.test(key)) {
      key = `${bedrock[1]}-${key}`;
    }
  }
  key = key.slice(key.lastIndexOf("/") + 1);
  const colon = key.indexOf(":");
  if (colon >= 0) {
    const size = SIZE_TAG.exec(key.slice(colon + 1));
    key = key.slice(0, colon) + (size ? `-${size[0]}` : "");
  }
  key = key
    .replace(/[\s_]+/g, "-")
    .replace(/(\d)p(\d)/g, "$1.$2")
    .replace(VENDOR_PREFIX, "");
  for (let previous = ""; previous !== key;) {
    previous = key;
    key = key.replace(DATE_SUFFIX, "").replace(SERVING_SUFFIX, "");
  }
  return (
    key
      .replace(/^claude-([\d.-]+)-(opus|sonnet|haiku|fable|mythos)/, "claude-$2-$1")
      .replace(/^(gpt-|minimax-m)(\d)(\d)(?=-|$)/, "$1$2.$3")
      .replace(/(?<=\d)-(?=\d{1,2}(-|$))/g, ".")
      // Zero minors are the same release: mistral-large-4-0 and mistral-large-4.
      .replace(/(?<=\d)(\.0)+(?=-|$)/g, "")
      .replace(/^solar-(pro|mini)-(?=\d)/, "solar-$1")
      .replace(/^qwen-(?=\d)/, "qwen")
      .replace(/^(gemma|llama)(?=\d)/, "$1-")
  );
}

export type CanonicalModelFamily = {
  /** Key without version numbers; size tokens such as `27b` stay. */
  name: string;
  version: number[];
};

/** `gpt-5.6-luna` -> `{ name: "gpt-luna", version: [5, 6] }`. */
export function canonicalModelFamily(key: string): CanonicalModelFamily {
  const name: string[] = [];
  const version: number[] = [];
  for (const token of key.split("-")) {
    // `qwen3.8` -> word `qwen`, version 3.8; tokens without a version keep their text.
    const [, word = token, digits] = VERSION_TOKEN.exec(token) ?? [];
    if (digits) {
      version.push(...digits.split(".").map(Number));
    }
    if (word) {
      name.push(word);
    }
  }
  return { name: name.join("-"), version };
}

/**
 * Positive when `a` is newer than `b`. Release times win when both are known
 * because version numbers do not always grow (grok-4.20 predates grok-4.7).
 */
export function compareModelRecency(
  a: string,
  b: string,
  releasedAt: ReadonlyMap<string, number>,
): number {
  const releasedA = releasedAt.get(a);
  const releasedB = releasedAt.get(b);
  if (releasedA !== undefined && releasedB !== undefined) {
    return releasedA - releasedB;
  }
  const versionA = canonicalModelFamily(a).version;
  const versionB = canonicalModelFamily(b).version;
  for (let index = 0; index < Math.max(versionA.length, versionB.length); index += 1) {
    const difference = (versionA[index] ?? -1) - (versionB[index] ?? -1);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
