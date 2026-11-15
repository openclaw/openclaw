import { decodeUtf8, utf8 } from "./encoding.js";

export interface CheckFinding {
  code: string;
  decision: "deny";
}

export interface CheckResult {
  allowed: boolean;
  text?: string;
  findings: CheckFinding[];
}

const MAX_BYTES = 32 * 1024;
const rules: Array<[string, RegExp]> = [
  ["private_key", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
  ["openai_key", /\bsk-[A-Za-z0-9_-]{16,}\b/],
  ["github_token", /\b(?:ghp|gho)_[A-Za-z0-9]{20,}\b/],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/],
  ["slack_token", /\bxox[bap]-[A-Za-z0-9-]{12,}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
];

export function deterministicChecks(input: string | Uint8Array): CheckResult {
  let text: string;
  let bytes: Uint8Array;
  try {
    if (typeof input === "string") {
      text = input;
      bytes = utf8(input);
      if (decodeUtf8(bytes) !== input) {
        throw new Error();
      }
    } else {
      bytes = input;
      text = decodeUtf8(input);
    }
  } catch {
    return { allowed: false, findings: [{ code: "invalid_utf8", decision: "deny" }] };
  }
  if (bytes.length > MAX_BYTES) {
    return { allowed: false, text, findings: [{ code: "too_large", decision: "deny" }] };
  }
  const findings: CheckFinding[] = [];
  for (const [code, pattern] of rules) {
    if (pattern.test(text)) {
      findings.push({ code, decision: "deny" });
    }
  }
  if (hasHighEntropyToken(maskGitHubCommitIds(text))) {
    findings.push({ code: "high_entropy_token", decision: "deny" });
  }
  return { allowed: findings.length === 0, text, findings };
}

// A full Git object id in a GitHub revision path is not, by itself, evidence of
// a secret. Mask only that occurrence for the entropy heuristic: known-secret
// rules and the model guard still inspect the original text. This recognizes
// syntax locally; it neither fetches links nor verifies repository visibility.
function maskGitHubCommitIds(text: string): string {
  // Consume whole URI-like tokens, including mailto/data and Markdown wrappers,
  // so nested references cannot exempt arbitrary query or fragment tokens.
  // Apostrophes are valid URI characters and must not split the containing URI.
  return text.replace(/(?<![a-z0-9+.-])[a-z0-9+.-]+:[^\s<>"`]+/gi, (url) =>
    url.replace(
      /^(https:\/\/github\.com\/[A-Za-z0-9-]+\/(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?:commit|blob|tree)\/)[A-Fa-f0-9]{40}(?=[/?#]|[)\]}.,;']*$)/,
      "$1<git-object-id>",
    ),
  );
}

function hasHighEntropyToken(text: string): boolean {
  const hexCandidates = text.match(/\b[A-Fa-f0-9]{32,}\b/g) ?? [];
  if (
    hexCandidates.some((candidate) => {
      if (/^(?:[0-9]+|[a-f]+)$/i.test(candidate) && new Set(candidate.toLowerCase()).size < 8) {
        return false;
      }
      return shannonEntropy(candidate) >= 3.5;
    })
  ) {
    return true;
  }
  const looseCandidates = text.match(/\b[A-Za-z0-9+_=]{32,}\b/g) ?? [];
  return looseCandidates.some(
    (candidate) =>
      /[A-Za-z]/.test(candidate) && /[0-9]/.test(candidate) && shannonEntropy(candidate) >= 4,
  );
}

export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}
