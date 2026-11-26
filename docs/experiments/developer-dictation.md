---
summary: "Proposed exact fragment dictation grammar, review lifecycle, and M08 qualification"
title: "Developer dictation"
read_when:
  - Reviewing the proposed developer dictation implementation
  - Testing exact syntax entry and protected transcript composition
---

# Developer dictation

This is an opt-in implementation proposal for
[M08 issue #205848](https://github.com/openclaw/openclaw/issues/205848).
It requires maintainer decisions about feature placement, the shared M11
contract, and saved profile ownership before readiness. It is not a claim that
the complete dictation package, native clients, or external insertion targets
have been qualified.

The initial client is the existing Control UI conversation composer. The pure
engine consumes recognized text locally. Existing speech recognition still owns
audio capture and transcription; this feature cannot restore spelling or
whitespace already changed by the recognizer. Review captures preserve each
provider-final chunk's bytes; a single space separates adjacent chunks only
when neither boundary supplies whitespace. It adds no language-model request,
external editor or project-context read, command execution, installation, or
external-application insertion capability.

## Choose a mode and review

Open **Dictation syntax** below the composer. Enable syntax review, choose
**English (en-US)** explicitly, and select a profile and mode:

| Mode      | Behavior                                                                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prose     | Existing dictation behavior; spoken command words stay prose.                                                                                                           |
| Literal   | Recognized words and whitespace remain exact. Explicit symbol, spelling, literal, and code scopes may transform their own ranges; identifier casing requires Developer. |
| Developer | Adds explicitly scoped identifier casing and the selected token-spacing profile.                                                                                        |

The feature starts disabled. Focusing an editor or terminal never changes the
mode. Unsupported locale/profile settings do not select English automatically;
choose a supported profile or Prose explicitly.

Literal and Developer captures stop at review. The review shows **Recognized
original**, **Exact preview**, diagnostics, and explicit alternatives. It offers
**Keep recognized original**, **Undo last transformation**, optional character inspection,
**Copy exact text**, **Cancel review**, and **Insert into draft**. Choosing a syntax
alternative reprocesses the same original capture; it does not apply a second
expansion to a previously transformed string.

The preview uses straight stored characters, a monospaced font with ligatures
disabled, and left-to-right code isolation. Original prose retains automatic
direction. Character inspection spells out spaces, tabs, line feeds, and Unicode
code points in text that assistive technology can read; it does not speak every
streaming token or start a text-to-speech provider.

Insertion writes one exact fragment into the still-current browser draft. It
does not trim terminal whitespace or add prose joining spaces. Send, keyboard
submission, and draft-history promotion remain separate from this review action.
The accepted insertion does not reinterpret slash commands such as `/goal`,
activate completion menus, or replace emoji shortcodes. Normal manual typing
afterward retains the composer's existing behavior.
The only implemented insertion adapter is the mounted unsent composer. For
terminals and other external destinations, use the copy action; no paste or
submit-key route is provided. Pasted newlines may execute in a terminal, which
is why a future M10 adapter requires its own qualification.

Browser text fields and the rich editor normalize carriage-return line endings.
When a candidate contains U+000D (including CRLF), insertion is unavailable and
the exact candidate stays in preview for copying. This prevents an insertion
that silently changes bytes. Character inspection distinguishes carriage returns
from line feeds.

The existing composer also treats a wholly whitespace-only draft as empty on
blur. A replacement that would leave a nonempty all-whitespace draft therefore
stays copy-only. Spaces, tabs, and newlines can be inserted beside other draft
content; an explicit empty replacement can still delete a selection. These
checks use the composed destination, not just the candidate, and leave existing
manual typing and empty-draft behavior unchanged.

## Versioned grammar

All four initial profiles use locale `en-US` and language scope `fragments-v1`.
They support exact fragments, not arbitrary program generation. Command labels
are matched as whole recognized words, case-insensitively; payload text retains
the profile's explicitly chosen rules.

| Command                        | Scope and termination                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `start code … end code`        | Spoken symbol phrases and nested identifier/spelling/literal commands. Nested code scopes are rejected. |
| `symbol … end symbol`          | One explicitly named symbol, including a whitespace command.                                            |
| `snake case … end identifier`  | Joins identifier words with underscores.                                                                |
| `camel case … end identifier`  | Lowercases the first word and capitalizes later word starts.                                            |
| `pascal case … end identifier` | Capitalizes each word start.                                                                            |
| `kebab case … end identifier`  | Joins identifier words with hyphens.                                                                    |
| `spell … end spell`            | Explicit letters/digits, including `capital`, `lower`, and `digit` labels.                              |
| `literal words … end literal`  | Preserves payload bytes, including otherwise meaningful command phrases.                                |

Literal-scope payload starts at its first payload token and ends at its last.
Whitespace between the scope labels and those tokens is grammar separation;
interior payload whitespace is preserved. Use explicit space, tab, or newline
commands when whitespace at the payload boundary is intended.

An opening command without its terminator is incomplete. A spelling label
without its letter/digit is incomplete. The engine does not supply a missing
terminator, bracket, quote, operator, or identifier. Prose such as “I said open
paren to describe the button” is unchanged.

Examples below omit surrounding prose, which is retained in order:

| Recognized input                                       | Exact output                                       |
| ------------------------------------------------------ | -------------------------------------------------- |
| `snake case customer account ID end identifier`        | `customer_account_id`                              |
| `camel case get user by ID end identifier`             | `getUserById` with the default word acronym policy |
| `pascal case http client end identifier`               | `HttpClient`                                       |
| `kebab case account ID end identifier`                 | `account-id`                                       |
| `spell capital A lower b digit zero end spell`         | `Ab0`                                              |
| `start code open paren x comma y close paren end code` | `(x, y)`                                           |
| `symbol literal backslash n end symbol`                | Two characters: backslash and `n`                  |
| `symbol new line end symbol`                           | One line-feed character, U+000A                    |
| `literal words open paren end literal`                 | `open paren`                                       |

Symbols include parentheses, brackets, braces, straight quotes, slash,
backslash, underscore, hyphen, punctuation, common operators, spaces, tabs,
line feeds, and literal `\n`/`\t` sequences. **Minus** and **dash** have visible
alternatives; neither is accepted as an invented certainty. Use **hyphen** to
request the ASCII hyphen-minus directly. A quoted existing token remains opaque.
Use a literal scope for arbitrary command-looking prose inside a code comment.

Existing closed same-line slash-delimited spans are conservatively opaque,
including escaped slashes and character classes. The engine does not guess
whether an ambiguous slash pair is a regular expression or arithmetic: raw
`x / y plus z / q` remains literal. Explicit spoken slash commands, as in
`start code x space slash space y plus z space slash space q end code`, produce
`x / y + z / q` under the TypeScript profile.

The `word` acronym policy gives `getUserById`. The `preserve` policy preserves
explicit all-uppercase acronym words, such as `getUserByID`. It does not inspect
workspace identifiers or infer an acronym policy from an application.

| Profile              | Token-spacing policy and diagnostic scope                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| Plain code           | Comma/colon spacing, operator spacing, two-space indentation; no language parser claim.               |
| JSON fragments       | Straight quotes, comma/colon spacing, no implicit operator spacing; JSON parse failures are advisory. |
| TypeScript fragments | Common delimiter/operator spacing and two-space indentation; delimiter/quote diagnostics only.        |
| Python fragments     | Common delimiter/operator spacing and four-space indentation; delimiter/quote diagnostics only.       |

TypeScript/Python diagnostics are bounded fragment checks, not compilers or
full-language validation. Incomplete code fragments remain usable with a warning.
No validation path executes the fragment or repairs its syntax.

## Profile files and rollback

Export a built-in profile, edit its data, and import it explicitly. A profile
contains a schema version, stable ID, revision, name, locale, language/version,
grammar labels, spelling labels, symbol mappings/alternatives, acronym policy,
straight-quote policy, and whitespace/indentation policy. New or replacement
profiles pass validation before replacing any authored mapping. A replacement
must advance the current profile revision; stale/downgrade imports fail.

| Bound                                     |                                   Limit |
| ----------------------------------------- | --------------------------------------: |
| Profile JSON                              |                         64 KiB of UTF-8 |
| Symbol mappings per profile               |                               256 total |
| Authored profiles in this browser setting |                                       8 |
| Transcript                                | 128 KiB of UTF-8 and 4,000 lexer tokens |
| Generated edits                           |                                      64 |
| One replacement                           |                         16 KiB of UTF-8 |
| Total replacement expansion               |                         64 KiB of UTF-8 |
| Result                                    |                        128 KiB of UTF-8 |

Profiles contain literal strings and bounded fixed policy values. Executable
fields, regex matcher definitions, recursive aliases, unknown fields, cyclic
symbol definitions, and overlapping command labels are rejected. Regex text such
as `/ab+/g` is valid literal replacement data. Imported output is never
reinterpreted as another command.

The documented pre-release schema-0 import shape has the same base fields but
omits revision, language version, grammar, and spelling. Import upgrades it to
schema 1 using the declared English grammar and revision 1. This is an interchange
migration test, not a claim that an upstream stable release shipped schema 0.
Unknown future versions remain unavailable rather than being coerced into schema 1.

Browser preferences use the existing Gateway-scoped settings record. Only mode,
locale, profile selection, enablement, and authored profile JSON are stored.
Dictated originals and previews are transient and are not saved by this feature.
Profile settings are excluded from server appearance-preference synchronization.
Invalid/future settings remain exportable. Disabling the feature preserves
authored mappings and existing draft text; it does not undo earlier document
edits or change a destination application's undo history.

## Shared composition and lifecycle

`src/shared/dictation-refinement.ts` supplies the proposed neutral composition
boundary. Its request and literal candidate shape follows the concrete M07 draft
at `7d8c99e9683ab86d65452d3de71ed3aa8463e6cc`, with explicit plan identity,
profile revision, unchanged protected ranges, and validation required by M08.
It is not an accepted public SDK or a completed M11 feature.

The actual shared-owner proposal is
[M11 issue #205845](https://github.com/openclaw/openclaw/issues/205845). Its
finality, target/context policy, result-state, and 32 KiB transcript proposal
have not been accepted or implemented on a verified M11 branch. This minimal
foundation currently uses the M07-shaped boundary and a 128 KiB transcript
limit. Those contracts and the same-path additions in sibling drafts must
converge before landing; this PR does not claim that agreement already exists.

Source and result offsets are half-open **UTF-16** ranges. Source slices must
match exactly; ranges must be bounded, ordered, nonoverlapping, and aligned to
Unicode graphemes. The explicit offset converter rejects byte/scalar indices
that split a grapheme. Composition also checks resulting protected boundaries.
Unpaired surrogates are rejected instead of being silently replaced by UTF-8
encoding. Each accepted replacement's output and existing exact tokens are
protected. Static snippet candidates can share the same ordered plan.

An optional prose stage receives only unprotected slices. Protected code,
spelling, and snippets never enter the stage's input and are concatenated
unchanged. No additional M01–M05 prose stage is enabled by this proposal; combined
qualification against those unmerged drafts remains outstanding.

The existing dictation owner retains audio sessions, stop/finalization, and FIFO
delivery. Its optional review hook captures the selected profile and destination
before asynchronous microphone work. Review invalidates when the profile,
client/account/session, compose permission, mounted editor, draft publication,
manual edit revision, or selection changes. Cancellation retires late finals.
No P02 context, P03 vocabulary, model proposal, project tree, file read, or
terminal scrollback is requested. Context-influenced raw recovery is not claimed.

## Qualification record

The implementation base is `openclaw/openclaw:main` at
`a40778940382325adc1a45e2ad321333be779cb0`. The selected issue is #205848. The
adjacent voice-button proposal is not a parent. The package-wide workflow,
architecture, stacking, validation, coverage, and dependency documents referenced
by the supplied prompt were unavailable; their contents are not inferred.

Run focused tests with the checkout's canonical `node scripts/run-vitest.mjs`
wrapper. The independent positive corpus is
`src/shared/dictation-developer.test-support.ts`; its expected strings are
authored independently of the parser. Negative cases are reported as behavior
tests, not included in exact-match accuracy. Acoustic word error rate remains
unmeasured.

Reproduce the deterministic component benchmark with:

```bash
node scripts/bench-dictation-developer.mts > developer-benchmark.json
```

The committed workload uses exactly 1,000 recognized tokens, a validated
256-term profile, and repeated late-lexicon symbols. It records 20 fresh-process
first calls, 20 warmups, 200 warm samples, rejected worst-case inputs, source/output
sizes, runtime/hardware, distributions, and exact-byte conformance by profile.
Grammar, composition, and process startup are separate. STT, rendering, and full
stop-to-preview latency are not included or claimed. The 50 ms p95 budget is an
evaluated target, not a supplied measurement.

### Observed component benchmark

The final component run on November 26, 2026 used an AMD EPYC 9V74 host with
nine reported logical CPUs, Linux x64, Node 24.22.3, V8 13.6.233.17-node.63,
and ICU 78.3. The host was shared, not a reserved reference device. The profile
contained 256 mappings and 9,713 serialized bytes; the input was 4,999 bytes and
the exact expected output was 995 bytes.

| Measured component                                       | Samples |    Median |       p95 |   Maximum |
| -------------------------------------------------------- | ------: | --------: | --------: | --------: |
| Warm grammar + composition                               |     200 |   3.69 ms |   7.48 ms |  62.13 ms |
| Fresh-process first grammar + composition                |      20 |  31.68 ms |  84.14 ms | 188.32 ms |
| Whole cold process, including imports/profile validation |      20 | 222.76 ms | 377.65 ms | 452.60 ms |

The warm transform met the proposed 50 ms p95 target in this run; the cold
transform did not. The full raw distributions, including outliers and the
earlier lookup implementation's measurement, are retained with the PR evidence.
These timings do not establish a phone, native editor, microphone, or complete
stop-to-preview performance claim.

All 220 measured reference transforms matched exact bytes. The independent
positive corpus matched 123/123 executions: plain code 29, JSON 29, TypeScript 33,
and Python 32. These are recognized-text conformance results, not speech accuracy.
The eight rejected-input groups each used 100 samples; near-limit late failures
included a 131,071-byte/4,001-token transcript, a 65,267-byte profile whose final
mapping duplicates a prior label, and a 131,071-byte transcript whose final
protected range splits a grapheme. All were rejected at their intended boundary.

Final observed results, source identity, independent review findings, and the
complete M08-AC01–AC11 ledger are recorded in the PR's Evidence section. Browser,
microphone, screen-reader, mobile/native, upstream CI, and design acceptance must
each be recorded explicitly rather than inferred from a passing pure corpus.
