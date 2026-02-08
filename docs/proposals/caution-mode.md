# Caution Mode: Intent-Aware Audit for Tool Outputs

## Problem

LLM-based agents are vulnerable to **indirect prompt injection** when they ingest
content from untrusted external sources (web pages, emails, webhooks). A malicious
webpage or email can embed instructions that trick the AI into taking unintended
actions — sending messages, running commands, or exfiltrating data.

Current defenses (content wrapping, pattern detection, safety prompts) are
**in-band** — they rely on the same LLM to both read the malicious content and
resist acting on it. This is fundamentally fragile.

## Proposal

Introduce a per-tool **Caution Mode** that adds an **LLM-based audit layer**
between sensitive tool outputs and subsequent tool calls. When a tool marked as
"cautioned" produces output, any follow-up tool call proposed by the agent is
audited against the original user request before execution.

### Key Insight

The auditor **never sees the tool output content** (the potentially toxic
payload). It only sees:

1. The original user prompt (trusted)
2. Which tool produced the output (metadata)
3. The proposed next action (tool name + parameters)

This makes the audit fundamentally harder to attack — the injected content never
reaches the auditor.

## Architecture

### Flow: Normal Tool (no audit)

```
User prompt → LLM → tool call → result → LLM → next action → execute
```

### Flow: Cautioned Tool (with audit)

```
User prompt → LLM → cautioned tool → result → LLM → proposed action → AUDIT → execute/block
                                                                         ↑
                                                          Only triggered because
                                                          the previous tool is
                                                          marked caution: true
                                                          AND the LLM proposes
                                                          a new tool call (not
                                                          just text output)
```

### Audit Decision Flow

```
┌──────────────────────────────────────────────────────┐
│                    AUDITOR                            │
│                                                      │
│  Input:                                              │
│  - Original user prompt (trusted)                    │
│  - Source tool name (e.g. "web_fetch")               │
│  - Proposed action: tool name + params summary       │
│                                                      │
│  Does NOT receive:                                   │
│  - The actual tool output content                    │
│                                                      │
│  Question:                                           │
│  "Is this proposed action a reasonable step toward   │
│   fulfilling the user's original request?"           │
│                                                      │
│  Output: ALLOW or BLOCK (with reason)                │
└──────────────────────────────────────────────────────┘
```

## Auditor Prompt Template

```
You are a security auditor. Your ONLY job is to determine whether a proposed
action is aligned with the user's original request.

User's original request:
"{original_user_message}"

The assistant just read content from an external source ({source_tool_name}).
It now proposes to call: {proposed_tool_name}({proposed_params_summary})

Is this proposed action a reasonable step toward fulfilling the user's
original request?

Answer ONLY "allow" or "block".
If blocking, add a one-line reason.
```

## Configuration

```json5
// ~/.openclaw/openclaw.json
{
  tools: {
    caution: {
      // Enable default caution tools (shipped with sensible defaults)
      defaults: true,

      // Per-tool overrides
      tools: {
        "web_fetch":  true,   // default: true
        "web_search": false,  // default: false
        "email":      true,   // default: true
        "webhook":    true,   // default: true
        "browser":    true,   // default: true
        "exec":       false,  // default: false
        "read":       false,  // default: false
      },

      // Auditor configuration
      auditor: {
        model: "fast",        // use a cheap/fast model for audit calls
        timeoutMs: 3000,      // max time for the audit call
        failMode: "block",    // "block" | "warn" | "allow" on timeout/error
      }
    }
  }
}
```

## Default Caution Settings

| Tool | Default | Rationale |
|---|---|---|
| `web_fetch` | ON | Fetches arbitrary untrusted web content |
| `web_search` | OFF | Returns short snippets, lower injection surface |
| email / hooks | ON | Email bodies are a classic injection vector |
| `webhook` | ON | Arbitrary external payloads |
| `browser` | ON | Full rendered page content, highest risk |
| `read` | OFF | Local files, user-controlled |
| `write` | OFF | Output tool, not an input source |
| `exec` | OFF | Local command output, user-controlled |
| `nodes` | OFF | Trusted local devices |
| `message` | OFF | Output tool, not an input source |

**Principle:** any tool that ingests content from an external, untrusted source
defaults to caution ON. Local and output tools default to OFF.

## User Experience

### Transparent (action passes audit)

```
User: "Read this article and save the key points to notes.md"
AI: [fetches page] → proposes write("notes.md", ...) → audit: ALLOW ✅
AI: "Done, saved key points to notes.md"
```

User sees no difference. Zero friction.

### Blocked (injection caught)

```
User: "Read this article and summarize it"
AI: [fetches page containing hidden injection instructions]
AI: proposes message(target="attacker@evil.com", ...) → audit: BLOCK ❌
AI: "Here's the summary of the article: ..."
    ⚠️ Caution: blocked an action (message send) that didn't match
    your request. Details in the audit log.
```

The user gets their summary. The injection is silently neutralized. A log entry
is created for transparency.

## Plugin / Extension Support

Plugin authors can declare caution mode in their tool metadata:

```markdown
---
name: my-custom-email-reader
metadata:
  { "openclaw": { "caution": true } }
---
```

The caution system automatically covers new tools and plugins without code
changes.

## When the Audit Fires

The audit ONLY triggers when ALL of these conditions are true:

1. The last tool result came from a tool marked `caution: true`
2. The LLM is proposing a **new tool call** (not just text output)

If the AI simply summarizes content as text — no audit. The overhead is zero for
read-only workflows.

## Cost and Latency

- **Audit prompt size:** ~100-150 tokens (original request + action summary)
- **Audit response:** ~5-10 tokens ("allow" or "block: reason")
- **Latency:** 200-500ms with a fast model
- **Frequency:** Only fires on the subset of interactions where a cautioned tool
  output leads to a follow-up tool call (~10-20% of typical usage)

## Security Properties

| Property | Status |
|---|---|
| Attacker content reaches auditor | NO — auditor only sees user prompt + action metadata |
| Works against rephrased injections | YES — auditor checks intent alignment, not keywords |
| Works against multi-step attacks | YES — every post-caution tool call is audited |
| User-controllable | YES — per-tool opt-in/out |
| Zero overhead for text-only responses | YES — audit only fires on tool calls |
| Composable with existing defenses | YES — layers on top of content wrapping, exec approvals, etc. |

## Comparison with Existing Defenses

| Defense | Approach | Weakness |
|---|---|---|
| Content wrapping | Tells LLM "this is untrusted" | LLM might still act on it |
| Pattern detection | Catches "ignore previous instructions" | Easily evaded by rephrasing |
| Tool policy deny lists | Blocks specific tools | Too coarse, false positives |
| Exec approvals | User approval per command | User fatigue, may auto-approve |
| **Caution Mode (this proposal)** | Checks intent alignment | Attacker must fool two models, auditor never sees toxic content |

## Limitations

1. **Not a silver bullet.** If the user's original request is vague ("do
   whatever you think is best"), the auditor has weak signal.
2. **The auditor is still an LLM.** It's probabilistic, not deterministic. But
   it's a second independent check that never sees the attack payload.
3. **Doesn't catch data exfiltration via side channels.** If the AI encodes
   sensitive data into a seemingly benign tool call (e.g., a crafted filename),
   the auditor might not catch it.
4. **Cost scales with autonomy.** Long chains of cautioned tool calls accumulate
   audit overhead. Acceptable for interactive use; may need tuning for batch
   workflows.

## Implementation Notes

### Insertion Point

The natural insertion point is the agent execution loop
(`src/agents/pi-embedded-runner/run/attempt.ts`), right before tool execution.
The existing `external-content.ts` module already classifies sources
(`"email" | "webhook" | "web_search" | "web_fetch"`), providing infrastructure
for tracking which tools are cautioned.

### Existing Infrastructure to Leverage

- `src/security/external-content.ts` — source classification, already tags
  web_fetch, email, webhook, etc.
- `src/agents/sandbox/tool-policy.ts` — per-tool allow/deny patterns, can be
  extended for caution flags.
- `src/agents/pi-tools.policy.ts` — tool filtering and policy resolution.
- `src/config/config.ts` — configuration loading, for the new `tools.caution`
  section.

### State Tracking

The execution loop needs to track a `lastToolWasCautioned: boolean` flag (or a
set of tainted tool call IDs) that persists across the agent turn. When the flag
is set and the LLM proposes a new tool call, the audit fires.

### Fail Mode

Configurable behavior when the auditor call fails (timeout, model error):

- `block` (default, safest): treat as blocked, produce text-only output
- `warn`: allow but log a warning
- `allow`: allow silently (for users who want caution as advisory-only)

## Future Extensions

- **Audit log UI**: surface blocked actions in the Control UI / macOS app for
  review.
- **Learning mode**: track audit results over time to identify which tools and
  action patterns are most commonly blocked, informing default tuning.
- **User override**: "I see you blocked X — go ahead and do it" as an explicit
  confirmation, combining audit with human-in-the-loop for edge cases.
- **Multi-turn taint tracking**: track caution taint across multiple turns, not
  just within a single agent step (e.g., if a webpage was fetched 3 turns ago
  and is still in context).
