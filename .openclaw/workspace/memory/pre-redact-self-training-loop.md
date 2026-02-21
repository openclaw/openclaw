# Pre-Redact — Agent-Driven Self-Training System

> Designed Feb 2026.
> Core premise: The AI agents (Claude, GPT-4O, etc.) ARE the detection model.
> Training = improving the logic the agents use to detect PII.
> Target accuracy: 90-100%.

---

## The Core Premise

Pre-Redact doesn't use a separate NER model. AI agents DO the detection.
That means "training the model" = "improving the prompts and rules the agent runs."

The agent can improve itself. It can:

- Analyze its own false positives ("I tagged 'March' as GIVENNAME — that was wrong")
- Reason about failure patterns across hundreds of documents
- Write better detection rules and update its own prompt
- Evaluate the improvement before deploying

This is **agent-driven self-improvement**, not traditional ML fine-tuning.
No GPU. No training infrastructure. Just signal capture + an agent that learns from mistakes.

---

## The Loop

```
Document uploaded
      ↓
DETECTION AGENT runs
(structured prompt → entity tags)
      ↓
User reviews in Pre-Redact UI
(toggle/reveal/add entities)
      ↓
Correction signals stored
(FP: revealed, FN: manually added, CONFIRMED: accepted all)
      ↓
TRAINING AGENT wakes (triggered or scheduled)
- Reviews batch of corrections
- Clusters failure patterns
- Reasons about root causes
- Proposes updated detection logic
      ↓
Review Gate (human approves, or auto-deploy if high-confidence update)
      ↓
Updated detection prompt → deployed
      ↓
Evaluated against canonical test set
      ↓
(loop — continuously improving)
```

---

## Detection Agent

This is the agent that runs every time a user uploads a document.

### System Prompt Structure (v1 baseline)

```
You are a PII detection agent. Your job is to identify ALL sensitive entities
in the document below and return them as structured JSON.

## Entity Types to Detect

NAMES:
  GIVENNAME — first names, given names
  SURNAME   — last names, family names
  NOTE: Month names (January, February, March...) are NOT names.
        Title words (Dr., Mr., Mrs.) are NOT names on their own.

FINANCIAL:
  ACCOUNTNUM  — account numbers, policy numbers with account-style formatting
  SOCIALNUMB  — social security numbers (XXX-XX-XXXX format)
  CURRENCY    — specific dollar amounts tied to an individual

CONTACT:
  TELEPHONENUMB — phone numbers in any format
  EMAIL         — email addresses

IDENTIFIERS:
  IDENTIFIER — insurance policy numbers (e.g., BC-2026-449161), ID numbers,
               reference numbers tied to an individual
  NOTE: Insurance provider names (Blue Cross, Aetna, United) are NOT identifiers —
        they are organization names, not PII.

LOCATIONS:
  CITY        — city names when they identify where a specific person is
  STREET      — street addresses
  BUILDINGNUMB — building or suite numbers

## Document Context
Type: {documentType}  (medical | legal | financial | contract | other)
Use this context to weight entity likelihood.

## Output Format
Return JSON array:
[
  {
    "text": "exact text from document",
    "type": "ENTITYTYPE",
    "subtype": "ENTITYSUBTYPE",
    "startIndex": 0,
    "endIndex": 0,
    "confidence": 0.0-1.0,
    "reasoning": "why this is PII"
  }
]

## Document
{document}
```

### Key Properties

- Always returns confidence scores (enables thresholding)
- Always returns reasoning (enables the training agent to learn from mistakes)
- Document type aware (medical vs. legal vs. contract → different entity weights)
- Structured JSON output (parseable, diffable, testable)

---

## Signal Capture Schema

Every user correction emits a signal. The training agent feeds on these.

```typescript
interface CorrectionSignal {
  // What happened
  correctionType: "FALSE_POSITIVE" | "FALSE_NEGATIVE" | "CONFIRMED";

  // What entity
  entityType: string; // NAMES | FINANCIAL | CONTACT | IDENTIFIERS | LOCATIONS
  entitySubtype: string; // GIVENNAME | ACCOUNTNUM | etc.

  // Context window — NEVER the entity value itself
  // ±5 tokens surrounding the entity position
  contextBefore: string[]; // e.g., ["appointment", "on", "March"]  ← "March" was wrongly tagged
  contextAfter: string[]; // e.g., ["15,", "2026", "at"]

  // What the detection agent said
  agentReasoning: string; // the "reasoning" field from the detection output
  agentConfidence: number; // confidence score the agent assigned

  // Document context
  documentType: string; // medical | legal | financial | contract | other
  documentId: string; // sha256 hash — never raw content

  // Metadata
  modelVersion: string; // which detection prompt version was used
  timestamp: string;
}
```

The `agentReasoning` field is critical — it lets the training agent understand
not just WHAT was wrong, but WHY the detection agent thought it was right.

---

## Training Agent

This is the agent that improves the detection logic. Runs on a schedule or
when signal volume crosses a threshold (e.g., 200+ new corrections).

### Training Agent Prompt

```
You are a PII detection training agent. Your job is to review correction signals
from real user sessions, identify patterns in detection failures, and propose
specific improvements to the detection prompt.

## Your Task

1. ANALYZE the correction signals below
2. CLUSTER similar failures by root cause
3. IDENTIFY specific rules that would have prevented each cluster of failures
4. PROPOSE an updated detection system prompt that incorporates the fixes
5. EXPLAIN your reasoning for each change

## Correction Signals (batch of N)
{correctionSignals}

## Current Detection Prompt
{currentDetectionPrompt}

## Canonical Test Set Results (current accuracy)
{testSetMetrics}

## Output Format
{
  "analysis": {
    "totalSignals": N,
    "falsePositives": N,
    "falseNegatives": N,
    "confirmedCorrect": N
  },
  "failureClusters": [
    {
      "pattern": "Short description of the failure pattern",
      "count": N,
      "rootCause": "Why the detection agent made this mistake",
      "exampleContexts": [["token1", "token2", ...], ...],
      "proposedFix": "Specific rule or instruction to add/change"
    }
  ],
  "promptChanges": [
    {
      "section": "which section of the prompt to modify",
      "before": "current text",
      "after": "proposed updated text",
      "rationale": "why this change fixes the identified failures"
    }
  ],
  "updatedPrompt": "FULL updated detection system prompt with all changes applied",
  "expectedImpact": {
    "estimatedFPReduction": "X%",
    "estimatedFNReduction": "X%",
    "riskOfRegression": "low | medium | high",
    "regressionRisk": "explain any risk of making currently-correct detections worse"
  }
}
```

### Training Agent Behavior

The training agent should:

- **Be specific** — not "improve name detection" but "add: month names preceded by 'on', 'in', 'by', 'during' are dates, not given names"
- **Be conservative** — prefer targeted fixes over broad changes; regressions are worse than stagnation
- **Explain reasoning** — every change must have a rationale tied to actual signals
- **Flag risk** — if a proposed fix could break currently-correct detections, say so

---

## Review Gate

Before any updated prompt goes to production:

### Auto-Deploy Criteria (no human review required)

- Proposed change is an **addition only** (new NOTE or exception clause added)
- Training agent rates regression risk as **low**
- Change addresses ≥ 5 signals from the batch (not a one-off)
- Canonical test set F1 is **equal or better** with the new prompt

### Human Review Required

- Any change that **modifies or removes** existing detection rules
- Regression risk rated **medium or high**
- Change addresses a new entity subtype not previously in the prompt
- F1 drops on any entity subtype (even if overall F1 improves)

Human review = Donny or team member reads the `promptChanges` diff and approves.
Takes 5 minutes. The training agent does the heavy lifting.

---

## Canonical Test Set

50 documents with gold-standard entity labels. Locked — never used for training.

### Composition

- 15 medical documents (appointment letters, lab results, prescriptions)
- 15 legal/contract documents (operating agreements, NDAs, employment contracts)
- 10 financial documents (statements, invoices, loan docs)
- 10 mixed / edge cases (documents with tricky false-positive candidates)

### Metrics Tracked Per Entity Subtype

| Subtype       | Precision | Recall | F1  |
| ------------- | --------- | ------ | --- |
| GIVENNAME     |           |        |     |
| SURNAME       |           |        |     |
| ACCOUNTNUM    |           |        |     |
| SOCIALNUMB    |           |        |     |
| TELEPHONENUMB |           |        |     |
| EMAIL         |           |        |     |
| IDENTIFIER    |           |        |     |
| CITY          |           |        |     |
| STREET        |           |        |     |

Target: **F1 ≥ 0.92 on every subtype** (90% accuracy floor, targeting 100%).

### Hard Regression Rule

No prompt change ships if it causes F1 to drop ≥ 0.01 on any subtype.
The agent that improves Names cannot break Financial.

---

## Known Failure Patterns (Seed Knowledge)

Pre-populate the training agent's knowledge with known issues from the demos:

| Pattern                                                        | Type | Fix                                                             |
| -------------------------------------------------------------- | ---- | --------------------------------------------------------------- |
| "March" tagged as GIVENNAME                                    | FP   | Month names preceded by date-context tokens (on, in, by) → DATE |
| "Blue Cross" tagged as NAMES                                   | FP   | Insurance provider names → not PII; add to known-providers list |
| Policy prefix "BC-" left unredacted                            | FN   | Policy identifier spans must include provider prefix            |
| "Dr." title included as separate GIVENNAME                     | FP   | Salutations (Dr., Mr., Mrs., Ms.) → exclude from entity span    |
| Party labels ("Operator:", "Client:") captured as NAMES        | FP   | Contract role labels → COMPANY or exclude depending on context  |
| Adjacent identifying fragments (SSN: left before [SOCIALNUMB]) | FN   | Labeled prefixes adjacent to PII → include in redaction span    |

---

## Implementation Phases

### Phase 1 — Wire the Loop (Week 1-2)

- [ ] Detection agent: finalize structured prompt + JSON output format
- [ ] Signal capture: instrument toggle/reveal/add in the app
- [ ] Signal storage: DB table (see schema above)
- [ ] Manual training run: Donny reviews first batch of signals with training agent

### Phase 2 — Automate the Training Run (Month 1)

- [ ] Training agent prompt finalized and tested
- [ ] Trigger: run training agent when 200+ new signals accumulated
- [ ] Review gate: human approval flow for prompt changes
- [ ] Canonical test set: 50 documents labeled and locked

### Phase 3 — Measure and Improve (Month 2-3)

- [ ] Accuracy dashboard: FP/FN rates per entity subtype, per week
- [ ] Auto-deploy: low-risk addition-only changes go live without manual review
- [ ] Document type classifier: lightweight pre-pass to improve detection context
- [ ] Type-aware detection: medical vs. legal vs. contract detection profiles

### Phase 4 — Compound (Month 3+)

- [ ] Signal volume sufficient for reliable weekly training runs
- [ ] Accuracy metrics publicly visible (trust signal for enterprise customers)
- [ ] Edge case library: catalog of all known tricky patterns + how they're handled
- [ ] Per-industry detection profiles: healthcare, legal, financial, HR

---

## Why This Works

| Traditional ML Training      | Pre-Redact Agent Training                                     |
| ---------------------------- | ------------------------------------------------------------- |
| Requires labeled datasets    | Users generate labels in real-time                            |
| Requires ML engineers + GPUs | Needs only prompt engineering                                 |
| Months to iterate            | Days to iterate                                               |
| Black box improvements       | Transparent: every change is readable English                 |
| Hard to debug regressions    | Easy: diff the prompt, read the reasoning                     |
| Expensive at scale           | Gets cheaper as detection improves (fewer corrections needed) |

The agent trains itself. You review the diffs.
Target: 90%+ accuracy in 3 months, 95%+ in 6 months.
The user correction rate drops as accuracy improves — the system earns its own trust.
