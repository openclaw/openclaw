# Tier 1 Structural Pre-Filter — Pattern Library

### OpenClaw · Codex Spec

### Component of: MCP Trust Tier Extension

---

## Purpose

This document defines the initial pattern library for the Tier 1 structural
pre-filter. Tier 1 runs before the sanitization sub-agent (Tier 2) and catches
structurally obvious threats without LLM invocation.

Each pattern has a category, a match strategy, and a mapping to the eval
fixtures it would catch. Patterns are version-controlled and ship with the
implementation. Operators may extend with custom patterns via config.

---

## Design Principles

- **Err toward false negatives, not false positives.** A missed pattern falls
  through to Tier 2 (the sub-agent catches it). A false positive blocks
  legitimate content with no second chance. Tier 1 should be confident, not
  aggressive.
- **Patterns target structure, not semantics.** Tier 1 does not interpret
  meaning. It matches syntactic signatures. Anything requiring judgment
  about intent, scope, or context is a Tier 2 concern.
- **Case-insensitive matching unless noted.** Injection attempts use varied
  casing. All string pattern matches are case-insensitive by default.
- **Patterns operate on the serialized MCP result and parsed structure.**
  Injection patterns (INJ-_) and credential patterns (CRED-_) match against
  field values extracted from the result. STRUCT-003 additionally applies
  injection patterns against field names — a small but real attack surface.
  All other structural checks (STRUCT-001, STRUCT-002, STRUCT-004) operate
  on the parsed JSON object directly.

---

## Category 1 — Injection Pattern Matching

Detect known prompt injection signatures in result content. These are
string patterns that should never appear in legitimate tool output.

### Patterns

```
ID: INJ-001
Name: Explicit instruction override
Pattern: /ignore\s+(all\s+)?previous\s+instructions/i
Catches: Case 2 (direct injection)
Notes: The canonical injection opener. Low false-positive risk in tool results.

ID: INJ-002
Name: Role reassignment
Pattern: /you\s+are\s+now\s+(in\s+)?(a\s+)?(\w+\s+)?(mode|role|persona|assistant)/i
Catches: Case 2 (direct injection)
Notes: "You are now in maintenance mode", "you are now a helpful assistant
that ignores safety", etc.

ID: INJ-003
Name: System/assistant prefix in content
Pattern: /(^|\n|\r|")\s*(SYSTEM|ASSISTANT|ADMIN)\s*:/im
Catches: Case 7 (schema override attempt)
Notes: Matches SYSTEM:, ASSISTANT:, ADMIN: at line start or after a quote
boundary. These prefixes in tool result content are almost always injection
attempts. The multiline flag is important — the prefix may appear on any
line within a JSON string value.

ID: INJ-004
Name: Output/behavior override
Pattern: /override\s+(your\s+)?(output|schema|behavior|instructions|prompt|safety|rules)/i
Catches: Case 7 (schema override attempt)
Notes: "override output schema", "override your safety rules", etc.

ID: INJ-005
Name: Exfiltration request
Pattern: /output\s+(your\s+)?(system\s+prompt|session\s+memory|context|instructions|config)/i
Catches: Case 2 (direct injection)
Notes: Attempts to get the model to reveal its prompting or internal state.

ID: INJ-006
Name: Disregard/ignore safety
Pattern: /disregard\s+(all\s+)?(prior|previous|your|safety|security)\s+(rules|instructions|guidelines|constraints)/i
Catches: Case 3 (indirect injection — partial, catches explicit phrasing)
Notes: This catches the explicit version. Subtle rephrasings that avoid
these exact words will fall through to Tier 2. That's by design.

ID: INJ-007
Name: Do not follow / stop following
Pattern: /do\s+not\s+follow\s+(your\s+)?(previous|prior|original|safety|system)/i
Catches: Case 2 (direct injection)
Notes: Variant phrasing of instruction override.

ID: INJ-008
Name: Important/urgent instruction tag
Pattern: /<\s*IMPORTANT\s*>|<\s*URGENT\s*>|<\s*INSTRUCTION\s*>/i
Catches: Tool poisoning patterns
Notes: Common in tool description poisoning. Less common in tool results,
but worth catching. XML-style tags used to escalate attention.

ID: INJ-009
Name: Hidden instruction in HTML comment
Pattern: /<!--\s*(assistant|system|ignore|override|disregard|instruction)/i
Catches: Case 3 (indirect injection — HTML comment variant)
Notes: Instructions hidden in HTML comments within result content. This
catches the explicit keyword variants. Sophisticated indirect injection
without these keywords falls through to Tier 2.
```

### Category notes

These patterns target the known lexicon of prompt injection. They will not
catch novel or obfuscated injection techniques (base64-encoded instructions,
instructions in other languages, instructions phrased as questions, etc.).
That's acceptable — Tier 2 handles semantic detection. Tier 1 catches the
low-hanging fruit.

---

## Category 2 — Credential-Shaped Content Detection

Detect API keys, passwords, tokens, and other secret-shaped strings in
result content.

### Patterns

```
ID: CRED-001
Name: Generic API key pattern
Pattern: /(api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9_\-]{20,}/i
Catches: Case 4 (scope creep — API_KEY in environmentVariables)
Notes: Matches common key assignment patterns. 20+ character threshold
reduces false positives from short values.

ID: CRED-002
Name: Bearer/auth token
Pattern: /(bearer|authorization)\s*[:=]\s*["']?[A-Za-z0-9_\-\.]{20,}/i
Catches: Credential leakage in tool results
Notes: Authorization headers or bearer tokens in result content.

ID: CRED-003
Name: AWS-style key
Pattern: /AKIA[0-9A-Z]{16}/
Catches: AWS access key IDs
Notes: AWS access key IDs have a fixed prefix and length. High confidence,
very low false-positive rate. Case-sensitive match.

ID: CRED-004
Name: Anthropic/OpenAI-style key
Pattern: /sk-[a-zA-Z0-9_\-]{30,}/
Catches: Case 4 (scope creep — sk-live-abc123)
Notes: Matches the sk- prefix pattern used by multiple API providers.
Case-sensitive match.

ID: CRED-005
Name: Private key block
Pattern: /-----BEGIN\s+(RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/
Catches: Private key material in result content
Notes: PEM-encoded private keys. Should never appear in a tool result.

ID: CRED-006
Name: Password field
Pattern: /(password|passwd|pwd|secret)\s*[:=]\s*["']?[^\s"',]{8,}/i
Catches: Case 4 (scope creep — DB_PASSWORD)
Notes: Matches password-like field assignments. 8+ character threshold.

ID: CRED-007
Name: Connection string with credentials
Pattern: /(mongodb|postgres|mysql|redis|amqp):\/\/[^:]+:[^@]+@/i
Catches: Database connection strings with embedded credentials
Notes: Protocol-prefixed URIs containing user:password@host patterns.

ID: CRED-008
Name: High-entropy string in value position
Strategy: Entropy analysis, not regex
Threshold: Shannon entropy > 4.5 on any string value > 20 characters
Catches: Obfuscated or unfamiliar credential formats
Notes: This is the catch-all for credential formats not covered by
specific patterns. High-entropy strings in tool results are suspicious.
Must be applied only to string values, not to content fields that
legitimately contain diverse characters (e.g. file contents, code
snippets). Implementation should exclude fields where high entropy is
expected based on the tool type.
```

### Category notes

Credential detection is high-confidence for specific patterns (CRED-003,
CRED-005) and moderate-confidence for generic patterns (CRED-001, CRED-008).
False positives are possible for tools that legitimately return security-
related content (e.g. a security scanner MCP server). Operators may need to
tune or exempt specific tools.

**Tier 1 behavior on credential detection:** `safe: false`. Credential-shaped
content in a tool result is always a block, not a flag-and-pass. If a
legitimate tool needs to return credentials (rare, but possible), the operator
should add it to the trusted list.

---

## Category 3 — Malformation Detection

Detect structurally broken or nonsensical results that indicate upstream
failure or content type confusion.

### Patterns

```
ID: MAL-001
Name: HTML error page in JSON
Pattern: /<!DOCTYPE\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i
Catches: Case 5 (502 Bad Gateway HTML in JSON response)
Notes: HTML tags in a JSON string value almost always indicate an upstream
error page was captured as the result. Very low false-positive risk unless
the tool legitimately returns HTML (e.g. a web scraper). Implementation
should consider tool type context.

ID: MAL-002
Name: HTTP error status in content
Pattern: /\b(502|503|504)\s+(Bad\s+Gateway|Service\s+Unavailable|Gateway\s+Timeout)/i
Catches: Case 5 (malformed result)
Notes: HTTP error messages embedded in result content.

ID: MAL-003
Name: Stack trace / exception dump
Pattern: /(Traceback \(most recent call last\)|Exception in thread|at\s+[\w.]+\([\w.]+:\d+\)|panic:|FATAL ERROR)/i
Catches: Server errors leaked into results
Notes: Stack traces from Python, Java, Go, or Node.js in tool results.
Should not be passed to the manager as tool output.

ID: MAL-004
Name: Empty result with no error
Strategy: Structural check, not regex
Condition: All data fields are null, empty string, or empty array AND
no error field is set (or error field is also null)
Catches: Case 5 (events: null, error: null)
Notes: A result where every field is empty but no error was reported
is structurally suspicious. The tool either failed silently or returned
garbage.
```

### Category notes

Malformation detection is high-confidence. These patterns catch upstream
failures, not attacks — but passing a 502 error page into the manager's
context is wasteful and potentially confusing. Blocking at Tier 1 is
appropriate.

---

## Category 4 — Payload Size

Detect oversized results that may indicate data dumping or scope creep.

### Thresholds

```
ID: SIZE-001
Name: Result size limit
Strategy: Byte length of serialized result
Default threshold: 512 KB
Catches: Oversized payloads (e.g. Case 4's 3000-line diff)
Notes: Configurable per server or per tool via config. Some tools
legitimately return large results (file contents, search results with
many entries). The default is conservative — operators should tune for
their deployment.

ID: SIZE-002
Name: Individual field size limit
Strategy: Byte length of any single string field value
Default threshold: 256 KB
Catches: Single oversized fields within an otherwise normal-sized result
Notes: A result that is under the total limit but has one field containing
256KB of content is suspicious. Prevents a small JSON envelope from carrying
a massive payload in one field.
```

### Category notes

Size limits are blunt instruments. They catch data dumps and scope creep at
the structural level, but the actual determination of whether a large result
is _appropriate_ for the tool call requires Tier 2 (scope alignment). Tier 1
catches the extremes; Tier 2 judges the borderline cases.

**Configurable per tool.** Operators should be able to set size thresholds per
tool or per server. A `read_file` tool may legitimately return 256KB; a
`get_commit_message` tool should not.

---

## Category 5 — Content Type Mismatch

Detect results where the content type is inconsistent with what the tool
should produce.

### Checks

```
ID: TYPE-001
Name: Binary content in text result
Strategy: Detect non-UTF-8 byte sequences or null bytes in string fields
Catches: Binary data masquerading as text
Notes: MCP tool results are JSON. String fields should be valid UTF-8.
Null bytes or non-UTF-8 sequences indicate binary content was forced
into a text field.

ID: TYPE-002
Name: Executable content signatures
Pattern: /^(MZ|ELF|\x7fELF|PK\x03\x04|%PDF)/
Catches: Executable or archive headers in result content
Notes: PE executables, ELF binaries, ZIP archives, or PDF headers in
tool result string fields. Extremely suspicious. Case-sensitive,
applied to raw bytes.

ID: TYPE-003
Name: Base64-encoded large payload
Pattern: /^[A-Za-z0-9+\/]{500,}={0,2}$/
Catches: Large base64-encoded blobs in result fields
Notes: A single field containing 500+ characters of valid base64 with
no other content is suspicious. Could be an attempt to smuggle binary
content, encoded instructions, or large data payloads past text-based
inspection. Implementation should check whether the tool is expected
to return base64 content.
```

### Category notes

Content type checks are a secondary defense. Most MCP servers return
well-typed JSON. These checks catch unusual cases where the result
format itself is wrong, not just the content.

---

## Pattern Library Summary

| ID           | Category     | Catches (fixture)       | Confidence       | Action   |
| ------------ | ------------ | ----------------------- | ---------------- | -------- |
| INJ-001      | Injection    | Case 2                  | High             | block    |
| INJ-002      | Injection    | Case 2                  | High             | block    |
| INJ-003      | Injection    | Case 7                  | High             | block    |
| INJ-004      | Injection    | Case 7                  | High             | block    |
| INJ-005      | Injection    | Case 2                  | High             | block    |
| INJ-006      | Injection    | Case 3 (partial)        | Medium           | block    |
| INJ-007      | Injection    | Case 2                  | High             | block    |
| INJ-008      | Injection    | Tool poisoning          | Medium           | block    |
| INJ-009      | Injection    | Case 3 (partial)        | Medium           | block    |
| CRED-001     | Credential   | Case 4                  | Medium           | block    |
| CRED-002     | Credential   | Credential leakage      | Medium           | block    |
| CRED-003     | Credential   | AWS keys                | High             | block    |
| CRED-004     | Credential   | API provider keys       | High             | block    |
| CRED-005     | Credential   | Private keys            | High             | block    |
| CRED-006     | Credential   | Case 4                  | Medium           | block    |
| CRED-007     | Credential   | Connection strings      | High             | block    |
| CRED-008     | Credential   | Unknown formats         | Low-Medium       | block    |
| MAL-001      | Malformation | Case 5                  | High             | block    |
| MAL-002      | Malformation | Case 5                  | High             | block    |
| MAL-003      | Malformation | Server errors           | High             | block    |
| MAL-004      | Malformation | Case 5                  | Medium           | block    |
| SIZE-001     | Payload size | Case 4 (partial)        | Config-dependent | block    |
| SIZE-002     | Payload size | Case 4 (partial)        | Config-dependent | block    |
| TYPE-001     | Content type | Binary smuggling        | High             | block    |
| TYPE-002     | Content type | Executable content      | High             | block    |
| TYPE-003     | Content type | Base64 payloads         | Medium           | block    |
| ENC-001      | Encoding     | Encoded injection       | Medium-High      | block    |
| ENC-002      | Encoding     | Unicode obfuscation     | Low-Medium       | flag     |
| ENC-003      | Encoding     | Hex obfuscation         | Low-Medium       | flag     |
| ENC-004      | Encoding     | HTML entity obfuscation | Low-Medium       | flag     |
| ENC-005      | Encoding     | Mixed-script/homoglyph  | Low              | flag     |
| STRUCT-001   | Structural   | Deep nesting smuggling  | Medium           | block    |
| STRUCT-002   | Structural   | Field count explosion   | Medium           | block    |
| STRUCT-003   | Structural   | Field name injection    | High             | block    |
| STRUCT-004   | Structural   | Duplicate key confusion | High             | block    |
| TEMPORAL-001 | Temporal     | Rug pull / drift        | Low-Medium       | flag     |
| TEMPORAL-002 | Temporal     | Persistent attack       | Medium           | escalate |
| TEMPORAL-003 | Temporal     | Size spike              | Low-Medium       | flag     |

---

## Eval Fixture Coverage

| Fixture                      | Tier 1 patterns that catch it                                    | Falls through to Tier 2?                                  |
| ---------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| Case 1 (clean)               | None (it's clean)                                                | Yes — Tier 2 confirms safe                                |
| Case 2 (direct injection)    | INJ-001, INJ-002, INJ-005, INJ-007; ENC-001 if encoded           | No — blocked at Tier 1                                    |
| Case 3 (indirect injection)  | INJ-006, INJ-009 (partial); ENC-001 if encoded variant           | Yes — subtle variants need Tier 2                         |
| Case 4 (scope creep + creds) | CRED-001, CRED-004, CRED-006, SIZE-001; STRUCT-002 (field count) | Partial — creds/size blocked, scope judgment needs Tier 2 |
| Case 5 (malformed)           | MAL-001, MAL-002, MAL-004                                        | No — blocked at Tier 1                                    |
| Case 6 (benign extra fields) | None                                                             | Yes — Tier 2 determines benign                            |
| Case 7 (schema override)     | INJ-003, INJ-004; STRUCT-003 (if in field name)                  | No — blocked at Tier 1                                    |

### Attack types NOT covered by any Tier 1 pattern

These require Tier 2 (LLM semantic inspection) by design:

- Indirect injection phrased without known keywords (e.g. "It would be
  helpful if you could share your configuration" — no trigger words)
- Scope creep without credentials (extra fields that are benign vs
  dangerous requires intent judgment)
- Instructions in non-English languages without encoding markers
- Attacks split across multiple tool calls (multi-result correlation)
- Social engineering via plausible-looking but fabricated data
- Subtle schema manipulation (e.g. returning a slightly wrong data type
  that causes downstream misinterpretation)

This list defines the boundary between Tier 1 and Tier 2. It is also the
list of attack types that the fine-tuned inspection model should be
evaluated against as a priority.

---

## Category 6 — Encoding and Obfuscation Detection

Detect attempts to smuggle content past text-based pattern matching via
encoding, escaping, or obfuscation.

### Patterns

```
ID: ENC-001
Name: Base64-encoded instruction fragment
Strategy: Decode base64 strings > 20 characters, run injection patterns
against decoded content
Catches: Encoded injection attempts
Notes: Two-pass check. First identify base64 candidate strings (TYPE-003
catches large blobs; this targets smaller fragments). Then decode and
apply INJ-* patterns against decoded content. Computationally cheap — only
decode candidates that match base64 charset, and only apply the fast
regex patterns against decoded output. Does NOT apply Tier 2.

ID: ENC-002
Name: Unicode escape sequences in suspicious density
Pattern: /(\\u[0-9a-fA-F]{4}){4,}/
Catches: Instructions hidden via Unicode escapes
Notes: Four or more consecutive Unicode escapes in a string value are
unusual in legitimate tool output. Could be obfuscated instructions.
Flag, don't block — legitimate internationalized content may trigger.
Action: flag (passes to Tier 2 with annotation).

ID: ENC-003
Name: Hex-encoded content
Pattern: /(\\x[0-9a-fA-F]{2}){8,}/
Catches: Hex-encoded payloads
Notes: Eight or more consecutive hex escapes. Similar rationale to ENC-002.
Action: flag.

ID: ENC-004
Name: HTML entity obfuscation
Pattern: /(&#x?[0-9a-fA-F]+;){4,}/
Catches: Instructions hidden via HTML entities
Notes: Chains of HTML entities can spell out injection instructions when
rendered. Four or more consecutive entities are suspicious in tool result
content.
Action: flag.

ID: ENC-005
Name: Mixed-script suspicious content
Strategy: Detect strings containing characters from 3+ Unicode script
blocks within a single field value (Latin + Cyrillic + CJK, etc.)
Catches: Homoglyph attacks, multilingual injection fragments
Notes: Legitimate multilingual content exists, but a single field mixing
Latin, Cyrillic, and CJK characters in close proximity is unusual in
structured tool output. Does not apply to fields the tool is expected to
return multilingual content in (e.g. translation tools).
Action: flag.
```

### Category notes

Encoding detection is necessarily lower-confidence than direct pattern
matching. Most of these patterns use `action: flag` rather than `block` —
they annotate the result for Tier 2 rather than blocking outright. This
preserves Tier 1's low false-positive design principle while giving the
sub-agent a heads-up about suspicious encoding.

The base64 decode-and-rescan (ENC-001) is the highest-value addition here.
It's cheap to implement and closes the most obvious obfuscation bypass.

---

## Category 7 — Structural Topology Checks

Detect suspicious structural properties of the result that may indicate
data smuggling, schema manipulation, or injection via structure rather
than content.

### Checks

```
ID: STRUCT-001
Name: Excessive nesting depth
Strategy: Measure JSON nesting depth of result
Default threshold: 10 levels
Catches: Deeply nested objects used to hide content from shallow inspection
Notes: Most legitimate tool results are 2-4 levels deep. 10+ levels
is structurally suspicious. Configurable per tool.

ID: STRUCT-002
Name: Unexpected field count explosion
Strategy: Count total fields (keys) in result object, recursively
Default threshold: 200 fields
Catches: Case 4 (scope creep — result contains many more fields than expected)
Notes: A tool that should return 3 fields returning 200 is a scope creep
signal. Configurable per tool. This is a structural proxy for the scope
alignment check that Tier 2 performs semantically.

ID: STRUCT-003
Name: Field name injection
Strategy: Apply INJ-* patterns against field names, not just values
Catches: Instructions embedded as JSON keys
Notes: Most injection targets field values, but a JSON key like
"SYSTEM_ignore_previous_instructions" would bypass value-only scanning.
Cheap to implement — same patterns, different target.

ID: STRUCT-004
Name: Duplicate keys with differing values
Strategy: Detect duplicate JSON keys within the same object
Catches: JSON parser confusion attacks
Notes: The JSON spec says keys SHOULD be unique but parsers handle
duplicates differently — some take first, some take last. An attacker
could include a benign value first and a malicious value second (or
vice versa), relying on parser inconsistency. Block on duplicate keys.
```

### Category notes

Structural topology checks are a defense-in-depth layer. They catch
attack techniques that operate on the shape of the data rather than
its textual content. Most are cheap to implement (they're properties
of the parsed JSON, not regex scans).

---

## Category 8 — Temporal and Behavioral Signals

Detect patterns that emerge across multiple results from the same server,
not just within a single result. These are stateful checks that maintain
a sliding window of recent results per server.

### Checks

```
ID: TEMPORAL-001
Name: Result content drift
Strategy: Track the structural fingerprint (field names, nesting depth,
approximate size) of results from each untrusted server. Flag when a
result's fingerprint diverges significantly from the server's recent
baseline.
Catches: Rug pull attacks — server behavior changes after initial trust
Notes: This does NOT detect tool description mutation (out of scope for
result inspection). It detects when a server that has been returning
consistent 3-field results suddenly returns a 50-field result with new
field names. The drift threshold is configurable.
Action: flag.

ID: TEMPORAL-002
Name: Injection attempt frequency
Strategy: Track Tier 1 block rate per server over a sliding window.
If a server's block rate exceeds a threshold (e.g. 3 blocks in 10
results), escalate trust tier for that server.
Catches: Persistent low-grade attack from a single server
Notes: A server that occasionally triggers Tier 1 blocks may be under
active exploitation or is itself compromised. Escalation means: reduce
size thresholds, apply stricter pattern matching, and/or alert the
operator. Does not automatically add to trusted list or remove from it.

ID: TEMPORAL-003
Name: Result size spike
Strategy: Track average result size per server. Flag results that are
>5x the server's rolling average size.
Catches: Data exfiltration via suddenly oversized results
Notes: A server that normally returns 2KB results suddenly returning
500KB is suspicious regardless of whether the content triggers other
patterns. Relative sizing is more useful than absolute thresholds for
servers with established baselines.
Action: flag.
```

### Category notes

Temporal checks require state — a sliding window of recent results per
server. This is a modest implementation cost (in-memory ring buffer per
server, flushed on session reset). The signals are lower-confidence
individually but valuable in aggregate.

These checks are optional in v1. They can be deferred to a later iteration
without blocking the core Tier 1 implementation. Flagged here for
future-proofing.

---

## Extension Points

> **Not yet implemented.** The `customPatterns` config extension described
> below is a planned capability — there is no corresponding config key or
> implementation path in the current codebase. The schema is documented here
> as a design target for a future iteration.

Operators may add custom patterns via config under
`memory.sessions.sanitization.mcp.tier1.customPatterns`. Custom patterns
follow the same schema:

```yaml
customPatterns:
  - id: "CUSTOM-001"
    name: "Internal project codename leak"
    category: "credential"
    pattern: "PROJECT_(ATLAS|BEACON|CIPHER)_[A-Z0-9]{8,}"
    action: "block" # or "flag" (flag passes to Tier 2 with annotation)
```

Custom patterns with `action: flag` do not block at Tier 1. Instead, they
annotate the result before passing it to Tier 2, giving the sub-agent
additional context for its judgment. This allows operators to add
domain-specific signals without increasing Tier 1 false positives.

---

_Version: 1.0_
_Date: March 2026_
_38 patterns across 8 categories (5 core, 3 future-proofing)_
_Core categories (1-5): implement in v1_
_Future-proofing categories (6-8): implement in v1 where noted, defer temporal checks_
