import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";

const PERCENT_ESCAPE_RE = /%[0-9a-f]{2}/gi;
const UNICODE_ESCAPE_RE = /\\+u([0-9a-f]{4})/gi;
const REDACTED_CREDENTIAL = "<redacted>";

interface CredentialForms {
  literal: readonly string[];
  encoded: readonly string[];
}

function canonicalizePercentEscapes(text: string): string {
  return text.replace(PERCENT_ESCAPE_RE, (escape) => escape.toUpperCase());
}

function resolveCredentialForms(credentials: readonly string[]): CredentialForms {
  const literal = new Set<string>();
  const encoded = new Set<string>();
  for (const credential of credentials) {
    if (!credential) {
      continue;
    }
    const jsonEscaped = JSON.stringify(credential).slice(1, -1);
    literal.add(credential);
    literal.add(jsonEscaped);
    literal.add(jsonEscaped.replaceAll("/", "\\/"));
    encoded.add(
      new URLSearchParams([["credential", credential]]).toString().slice("credential=".length),
    );
    try {
      encoded.add(encodeURIComponent(credential));
    } catch {
      // Raw and JSON forms still cover malformed UTF-16 credentials that URI encoding rejects.
    }
  }
  const longestFirst = (left: string, right: string) => right.length - left.length;
  return {
    literal: [...literal].filter(Boolean).toSorted(longestFirst),
    encoded: [...encoded].filter(Boolean).map(canonicalizePercentEscapes).toSorted(longestFirst),
  };
}

function redactDirectCredentialForms(text: string, forms: CredentialForms): string {
  let redacted = text;
  for (const form of forms.literal) {
    redacted = redacted.replaceAll(form, REDACTED_CREDENTIAL);
  }
  redacted = canonicalizePercentEscapes(redacted);
  for (const form of forms.encoded) {
    redacted = redacted.replaceAll(form, REDACTED_CREDENTIAL);
  }
  return redacted;
}

function redactCredentialForms(text: string, forms: CredentialForms): string {
  const directlyRedacted = redactDirectCredentialForms(text, forms);
  const unicodeCanonicalized = directlyRedacted.replace(
    UNICODE_ESCAPE_RE,
    (_escape, codeUnit: string) => String.fromCharCode(Number.parseInt(codeUnit, 16)),
  );
  if (unicodeCanonicalized === directlyRedacted) {
    return directlyRedacted;
  }

  const canonicalizedRedaction = redactDirectCredentialForms(unicodeCanonicalized, forms);
  // Preserve unrelated escaped diagnostic text unless decoding it reveals a
  // request credential that must be removed before parsing or presentation.
  return canonicalizedRedaction === unicodeCanonicalized
    ? directlyRedacted
    : canonicalizedRedaction;
}

function redactJsonCredentialText(text: string, forms: CredentialForms): string | undefined {
  try {
    // Decode valid JSON before matching so alternate escapes cannot reconstruct
    // the credential when a caller parses the presented body downstream.
    const parsed = JSON.parse(text) as unknown;
    const serialized = JSON.stringify(parsed, (_key, value: unknown) =>
      typeof value === "string" ? redactCredentialForms(value, forms) : value,
    );
    return serialized === undefined ? undefined : redactCredentialForms(serialized, forms);
  } catch {
    return undefined;
  }
}

/** Remove raw, serialized, and encoded credentials before generic redaction. */
export function redactQQBotCredentialText(text: string, ...credentials: readonly string[]): string {
  const credentialForms = resolveCredentialForms(credentials);
  if (credentialForms.literal.length === 0 && credentialForms.encoded.length === 0) {
    return redactToolPayloadText(text);
  }

  const withoutExactCredential =
    redactJsonCredentialText(text, credentialForms) ?? redactCredentialForms(text, credentialForms);
  return redactToolPayloadText(withoutExactCredential);
}
