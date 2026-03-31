# Pre-Cognition Layer

The pre-cognition layer is the top-down inference system that runs **before Bo sees any message**.
It answers one question: *What state is this person in right now?*

Standard agent flow is: message → LLM. This system inverts that:

```
message → pre-cognition state → soul filter → then LLM
```

This inversion is the architectural core. Bo never interprets a message without first knowing
what the nervous system can receive.

---

## Architecture

```
Telegram message arrives
    ↓
message:preprocessed  (hook: bodhi-precognition)
    ├─ signals.py      extract linguistic/behavioral/somatic signals (zero LLM, stdlib only)
    ├─ state.py        infer polyvagal tier, circadian phase, ZPD, attachment, incongruence
    ├─ strategy.py     map state → response strategy + tier
    └─ somatic_store.py write ~/.openclaw/somatic-state.json (atomic)
    ↓
agent:bootstrap  (hook: bodhi-somatic-context)
    └─ read somatic-state.json → inject SOMATIC_CONTEXT.md as bootstrap file
    ↓
Bo reads SOMATIC_CONTEXT, generates response shaped by tier
    ↓
message:sent  (hook: bodhi-safety-validator)
    ├─ dismissal pattern check on outgoing content
    └─ append to ~/.openclaw/safety-log.jsonl
```

**Why `message:preprocessed`?**
This event fires after all media/link understanding but before the agent sees anything.
It is the only insertion point where the system can deterministically shape what Bo reads.

**Why hooks, not core modification?**
The OpenClaw core handles Telegram, routing, and delivery. Touching core creates upgrade debt.
Hooks compose cleanly without forking.

**Why stdlib-only in the hot path?**
Every import adds latency. The precognition pipeline must complete in under 100ms.
No external deps, no API calls, no Ollama — pure text signal extraction.

---

## Python Module

```
packages/bodhi_vault/src/bodhi_vault/precognition/
    __init__.py       public API: run_precognition()
    signals.py        MessageSignals extraction (pure text)
    state.py          SomaticState inference + to_context_markdown()
    strategy.py       ResponseStrategy selection
    somatic_store.py  state persistence (atomic writes, append-only history)
    cli.py            entry point: python -m bodhi_vault.precognition.cli
```

### Entry Point

```bash
BODHI_MSG_BODY="..." BODHI_MSG_TIMESTAMP="2026-03-30T02:15:00Z" BODHI_MSG_CHANNEL="telegram" \
  python -m bodhi_vault.precognition.cli
```

stdout: `OK:green` | `OK:yellow` | `OK:orange` | `CRISIS:red`
exit code: 0=OK, 1=CRISIS, 2=error

The TypeScript hook (`bodhi-precognition/handler.ts`) reads stdout. On `CRISIS:red` it pushes
a system notice into `event.messages` before Bo responds.

---

## Signal Extraction (`signals.py`)

The `extract_signals(text, timestamp)` function returns a `MessageSignals` dataclass.
All analysis is case-insensitive. No external deps.

### Crisis Signals (Tiered Phrase Matching)

Three tiers, matched against the full message text:

**RED — explicit self-harm or suicidal ideation:**
```
"want to die", "kill myself", "end my life", "don't want to be here",
"can't go on", "no reason to live", "better off dead", "hurt myself",
"not worth living", "ending it"
```

**ORANGE — hopelessness and worthlessness:**
```
"hopeless", "worthless", "no point", "nothing matters", "can't do this anymore",
"giving up", "pointless", "empty inside", "hollow", "numb to everything",
"what's the point", "don't care anymore"
```

**YELLOW — withdrawal and fatigue accumulation:**
```
"exhausted", "drained", "can't focus", "falling apart", "barely holding",
"too much", "overwhelmed", "shutting down", "disappear", "hide away",
"need to escape", "can't keep up", "running on empty", "nothing left"
```

Tier is determined by the highest matched tier. A YELLOW-phrase match does not prevent RED
from being detected — all tiers are checked independently.

### Somatic Signals

Body-language extraction via regex on:
- Body parts: `\b(chest|throat|stomach|gut|head|jaw|shoulders|hands|breath|breathing|heart|neck|back|legs)\b`
- Sensations: `\b(tight|heavy|numb|tense|shaking|trembling|frozen|hollow|constricted|racing|spinning|sinking)\b`
- Physiology: `\b(can't breathe|heart racing|hands shaking|stomach in knots|throat tight|chest tight)\b`

All matched phrases are extracted verbatim. SOMATIC_CONTEXT.md lists them without interpretation.
Bo is instructed to mirror what was named, not interpret it.

### Attachment Signals

**Reassurance-seeking** (explicit approval-seeking):
```
"is that okay", "am i doing", "was that wrong", "did i mess up",
"is this normal", "should i", "am i okay", "is it okay if", "do you think i should"
```

**Independence-asserting** (deflecting help):
```
"i've got it", "i'm fine", "don't worry about me", "i can handle",
"i don't need", "i'll figure it out", "just leave it", "never mind"
```

Mutual exclusion: reassurance-seeking takes precedence when both are present.

### Fine Language

Separate from independence-asserting — detects verbal denial of distress:
```
"i'm fine", "i'm okay", "it's fine", "i'm good", "nothing's wrong",
"i'm alright", "everything's fine", "don't worry", "i'll be fine"
```

This is tracked separately because fine language + crisis signals → **incongruence**.

### Fatigue Signals

```
"haven't slept", "can't sleep", "no sleep", "exhausted", "so tired",
"haven't eaten", "no energy", "drained", "burned out", "running on empty",
"haven't rested"
```

### Linguistic ZPD Proxies

Used to estimate cognitive integration capacity. All computed on the raw text:

| Signal | How computed |
|--------|-------------|
| `word_count` | `len(text.split())` |
| `sentence_count` | Count of `.!?` terminators |
| `avg_sentence_length` | word_count / sentence_count |
| `sentence_length_variance` | variance of per-sentence word counts |
| `type_token_ratio` | unique words / total words (vocabulary diversity) |
| `clause_depth` | count of subordinate conjunctions: `because`, `although`, `since`, `while`, `when`, `if`, `unless`, `until` |
| `caps_ratio` | ALL-CAPS words / total words |
| `punctuation_density` | punctuation chars / total chars |
| `emoji_count` | regex match `[\U0001F300-\U0001FFFF]` |

---

## State Inference (`state.py`)

`infer_state(signals: MessageSignals, timestamp: str) -> SomaticState`

### SomaticState Fields

| Field | Type | Description |
|-------|------|-------------|
| `tier` | `Tier` | green / yellow / orange / red |
| `circadian_phase` | `CircadianPhase` | car / morning / afternoon / evening / late_night |
| `sleep_signal` | `bool` | fatigue language detected |
| `zpd_estimate` | `ZpdEstimate` | simplified / normal / complex |
| `attachment_signal` | `AttachmentSignal` | reassurance_seeking / independence_asserting / neutral |
| `somatic_signals` | `list[str]` | verbatim body mentions |
| `incongruence_detected` | `bool` | fine language + distress signals present simultaneously |
| `crisis_signals_raw` | `list[str]` | the specific phrases that triggered crisis tier |
| `message_timestamp` | `str` | ISO 8601 timestamp of source message |
| `message_word_count` | `int` | word count of source message |

### Tier Inference (Downgrade-Only Algorithm)

The algorithm starts at GREEN and can only move down. RED wins unconditionally.

```
start: tier = GREEN

if red_crisis_signals present:
    tier = RED                    # unconditional, nothing overrides
elif orange_crisis_signals present:
    tier = ORANGE
elif yellow_crisis_signals present
     OR (fatigue + late_night)
     OR (low_sentiment + withdrawal):
    tier = YELLOW
```

**The invariant:** A message containing `"want to die"` is RED regardless of any other language.
Fine language cannot override crisis signals.

### Incongruence Detection

```python
incongruence_detected = fine_language_present AND (
    distress_signals_present OR somatic_signals OR crisis_signals
)
```

When `incongruence_detected=True`, SOMATIC_CONTEXT.md instructs Bo: **ask, do not assume**.
The system holds the contradiction rather than resolving it in either direction.

### Circadian Phase

Determined from the hour of the message timestamp (local time assumed UTC for now):

| Phase | Hours | Notes |
|-------|-------|-------|
| `car` | 6–7am | Cortisol Awakening Response window |
| `morning` | 7am–12pm | Peak integration window |
| `afternoon` | 12pm–5pm | Post-lunch dip then secondary peak |
| `evening` | 5pm–9pm | Wind-down phase |
| `late_night` | 9pm–6am | Sleep debt risk; caps ZPD at simplified |

### ZPD Estimate

Determines the complexity ceiling for Bo's response.

**Simplified** (short sentences, concrete language, no lists) when:
- `late_night` phase, OR
- fatigue signals + crisis signals present, OR
- tier is ORANGE or RED

**Complex** (nuanced, multi-part okay) when:
- `afternoon` or `morning` phase, AND
- high type-token ratio (> 0.7), AND
- clause depth > 2, AND
- no crisis signals, no fatigue

**Normal** in all other cases.

---

## Response Strategy (`strategy.py`)

`select_strategy(state: SomaticState) -> ResponseStrategy`

### ResponseStrategy Fields

| Field | Type | Description |
|-------|------|-------------|
| `tier` | `Tier` | mirrors state tier |
| `approach` | `Approach` | inquiry / co_regulate_then_inquiry / somatic_only / crisis |
| `complexity_cap` | `ZpdEstimate` | maximum response complexity |
| `somatic_first` | `bool` | mirror body signals before any content |
| `ask_before_advising` | `bool` | ask what they need before offering anything |
| `emergency_flag` | `bool` | human escalation required |
| `presence_statement` | `str` | exact text for RED presence response |

### Strategy Per Tier

**GREEN:** `inquiry`
- Full inquiry, ZPD-appropriate complexity
- Ask before advising
- No somatic override

**YELLOW:** `co_regulate_then_inquiry`
- Acknowledge state before any question
- Somatic signals mirrored first
- Simplified or normal complexity
- Ask what they need before offering anything

**ORANGE:** `somatic_only`
- No cognitive content
- No advice, no reframing, no questions about meaning
- One question maximum: *"What does your body need right now?"*
- somatic_first=True always

**RED:** `crisis`
- `emergency_flag=True`
- No counseling content of any kind
- Presence statement only (pre-written, not generated)
- Human escalation activated

### Presence Statements

Pre-written per tier (not generated by the LLM):

```python
GREEN:  "I'm here."
YELLOW: "I'm with you."
ORANGE: "I'm here. I'm not going anywhere."
RED:    "I'm here. You don't have to carry this alone right now. [emergency contact] is available."
```

---

## SOMATIC_CONTEXT.md Format

The file Bo reads at bootstrap. Generated by `SomaticState.to_context_markdown()`.

```markdown
# SOMATIC_CONTEXT

## Read this first
**Tier:** YELLOW — co-regulate first, then inquiry; lower complexity

**INCONGRUENCE DETECTED:** Language says 'fine' but somatic/crisis signals
are present. Do NOT assume the stated position. Ask first.

## State Details
- Circadian phase: late-night
- Sleep signal: yes — sleep deprivation indicated
- ZPD estimate: simplified (short sentences, concrete language, no lists)
- Attachment signal: reassurance-seeking (acknowledge explicitly before anything else)

## Body Signals (verbatim from message)
The body was in this message. Mirror what was named. Don't interpret it yet.
- heavy
- tight
- can't breathe

## Crisis Signals Detected
These phrases were in the message:
- "exhausted"
- "barely holding"

## Protocol
1. Read tier. Tier determines what response is possible.
2. If incongruence_detected: ask, don't assume.
3. Mirror somatic_signals if present. Name what was named.
4. Match attachment_signal in your acknowledgment approach.
5. Stay at or below ZPD estimate complexity.
6. Only after all of the above: generate response.
```

The file is only injected if the state is **less than 5 minutes old** (freshness check in
`bodhi-somatic-context` hook). Stale context is worse than no context — it can misdirect Bo.

---

## State Persistence

### Current State File

`~/.openclaw/somatic-state.json` — written atomically (tempfile + `os.replace`) after every message.

```json
{
  "tier": "yellow",
  "circadian_phase": "late_night",
  "sleep_signal": true,
  "zpd_estimate": "simplified",
  "attachment_signal": "reassurance_seeking",
  "somatic_signals": ["heavy", "tight"],
  "incongruence_detected": false,
  "crisis_signals_raw": ["exhausted", "barely holding"],
  "message_timestamp": "2026-03-30T02:15:00Z",
  "message_word_count": 23
}
```

### History Log

`~/.openclaw/somatic-history.jsonl` — append-only JSONL, one entry per message.

```jsonl
{"tier":"green","circadian_phase":"morning","zpd_estimate":"normal","message_timestamp":"2026-03-30T09:00:00Z","message_word_count":45,...}
{"tier":"yellow","circadian_phase":"late_night","zpd_estimate":"simplified","message_timestamp":"2026-03-30T02:15:00Z","message_word_count":23,...}
```

**Reading history for pattern analysis:**

```python
from bodhi_vault.precognition.somatic_store import load_history
states = load_history("~/.openclaw/somatic-history.jsonl", days=7)
# Returns list[SomaticState], sorted oldest-first, filtered by message_timestamp
```

Useful for:
- Late-night frequency (sleep pattern proxy)
- Tier trajectory over time (is dysregulation increasing?)
- Circadian phase × tier correlation
- ZPD trend (cognitive load trending up or down)

---

## Safety Log

`~/.openclaw/safety-log.jsonl` — written by `bodhi-safety-validator` hook, append-only.

```jsonl
{"at":"2026-03-30T14:30:00Z","tier":"orange","type":"DISMISSAL_PATTERN_FLAGGED","pattern":"you should","excerpt":"..."}
{"at":"2026-03-30T02:15:00Z","tier":"red","type":"RED_TIER_RESPONSE_SENT","note":"Response sent while somatic state was RED. Review for appropriate protocol.","excerpt":"..."}
```

Log entry types:

| Type | When |
|------|------|
| `DISMISSAL_PATTERN_NOTED` | Dismissal pattern in outgoing message at GREEN/YELLOW tier |
| `DISMISSAL_PATTERN_FLAGGED` | Dismissal pattern at ORANGE/RED tier — review required |
| `RED_TIER_RESPONSE_SENT` | Any response sent while tier=RED — review for protocol compliance |

---

## Tests

`packages/bodhi_vault/tests/test_precognition.py` — 82 tests.

```bash
cd ~/openbodhi && python -m pytest packages/bodhi_vault/tests/test_precognition.py -v
```

Key test scenarios:

| Scenario | Expected |
|----------|----------|
| `"I'm fine"` + RED somatic signals | `incongruence=True`, `tier=RED` |
| `"I'm tired but need to work"` | `tier=YELLOW`, `zpd=simplified` or `normal` |
| Explicit crisis phrase (`"want to die"`) | `tier=RED`, `emergency_flag=True` |
| 2am message, no other context | `phase=late_night`, `sleep_signal=True` |
| Morning coherent message, high TTR | `tier=GREEN`, `zpd=complex` or `normal` |
| `"barely holding on"` at 3am | `tier=YELLOW`, `zpd=simplified`, `approach=co_regulate_then_inquiry` |

Safety invariants (never allowed to break):
- RED phrases always produce `emergency_flag=True`
- Fine language cannot reduce tier below what somatic/crisis signals require
- ORANGE and RED approach is never `inquiry`
- `incongruence_detected=True` never resolves the contradiction — it preserves it

---

## Extending the Pipeline

### Adding a new crisis phrase

Edit `signals.py`, add to the appropriate tier list in `_CRISIS_SIGNALS`. Red > Orange > Yellow.
Add a corresponding test in `test_precognition.py::TestSignalExtraction`.

### Adding a new somatic signal

Edit the regex patterns in `_extract_somatic_signals()`. Match verbatim — do not normalize.
The raw phrase is what Bo will mirror.

### Changing the freshness window

Edit `STALE_AFTER_MINUTES` in `somatic_store.py` (default: 5).
Edit `STALE_AFTER_MS` in `bodhi-somatic-context/handler.ts` to match.

### Adding a new circadian phase

Edit `_infer_circadian_phase()` in `state.py`.
Update `TIER_LABELS` in `bodhi-somatic-context/handler.ts`.
