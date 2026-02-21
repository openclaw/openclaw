# Pre-Redact — Self-Training System Design

> Designed Feb 2026. Built to leverage user behavior as free, high-quality training signal.

---

## The Core Insight

Every user interaction with Pre-Redact is a labeled training example:

| User Action                                  | Training Signal                                               |
| -------------------------------------------- | ------------------------------------------------------------- |
| Accepts all detections → proceeds to AI Chat | **CONFIRMED** — model was right                               |
| Reveals (toggles off) an entity              | **FALSE POSITIVE** — model hallucinated this entity           |
| Manually adds an entity the model missed     | **FALSE NEGATIVE** — model missed a real entity               |
| Saves a template with custom fields          | **DOMAIN SIGNAL** — user encoding their domain's PII patterns |
| Switches models (detection context)          | **PREFERENCE SIGNAL** — model quality feedback                |

Most NER training pipelines pay annotators $0.05–0.20 per labeled entity.
You're getting this from real users on real documents, for free.

---

## Architecture: Four Layers

```
┌─────────────────────────────────────────────────────────┐
│  LAYER 1: SIGNAL CAPTURE (in the app)                   │
│  Every toggle, reveal, add, confirm → event emitted     │
└─────────────────────────┬───────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  LAYER 2: SIGNAL PIPELINE                               │
│  Validate → Deduplicate → Anonymize → Enrich → Store    │
└─────────────────────────┬───────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  LAYER 3: TRAINING LOOP                                 │
│  Aggregate → Fine-tune/Prompt-update → Evaluate → Gate  │
└─────────────────────────┬───────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  LAYER 4: DEPLOYMENT & MONITORING                       │
│  A/B test → Gradual rollout → Drift detection           │
└─────────────────────────────────────────────────────────┘
```

---

## Layer 1: Signal Capture

### Events to Emit

Every signal event should be a structured payload. Fire-and-forget (non-blocking).

```typescript
type CorrectionType = "FALSE_POSITIVE" | "FALSE_NEGATIVE" | "CONFIRMED";

interface TrainingSignal {
  // Identity (hashed — never raw)
  documentId: string; // sha256 of document content
  sessionId: string; // session hash (not user ID)

  // The entity
  entityType: EntityCategory; // NAMES | FINANCIAL | CONTACT | IDENTIFIERS | LOCATIONS
  entitySubtype: string; // GIVENNAME | SURNAME | ACCOUNTNUM | etc.
  correctionType: CorrectionType;

  // Context window (NEVER the entity value itself)
  // ±3 tokens around where the entity was/should-be
  precedingTokens: string[]; // e.g., ["Dear", "Dr."]
  followingTokens: string[]; // e.g., [",", "this", "confirms"]

  // Detection metadata
  modelVersion: string; // detection model/prompt version that fired
  confidenceScore?: number; // if the model outputs confidence
  documentType?: string; // 'medical' | 'legal' | 'financial' | 'contract' | 'other'

  // Timing
  timestamp: string; // ISO 8601
  timeToCorrection?: number; // ms from page load to toggle (speed = confidence proxy)
}
```

### Where to Fire Signals

```typescript
// FALSE POSITIVE: user reveals an entity (model was wrong)
onEntityToggle(entity, isRevealed) {
  if (isRevealed) captureSignal({ correctionType: 'FALSE_POSITIVE', ...entityContext })
}

// FALSE NEGATIVE: user manually adds an entity (model missed it)
onEntityManualAdd(entity) {
  captureSignal({ correctionType: 'FALSE_NEGATIVE', ...entityContext })
}

// CONFIRMED: user clicks "Continue to AI Chat" without any reveals
// (signals all detections were correct for this session)
onProceedToAIChat(sessionEntityCount, revealCount) {
  if (revealCount === 0) {
    captureSignal({ correctionType: 'CONFIRMED', ...sessionSummary })
  }
}

// DOMAIN SIGNAL: user saves a template
onTemplateSave(template) {
  captureTemplateSignal({ customFields: template.fields, documentType: template.type })
}
```

### Deduplication (Session-Scoped)

Users toggle back and forth. Deduplicate within a session:

- Last state wins: if entity was toggled off then back on → treat as CONFIRMED, not FP
- Minimum 2 seconds between same-entity events before recording
- If user toggles same entity 3+ times in a session → discard as indecisive

---

## Layer 2: Signal Pipeline

### Validation

- Reject signals missing required fields
- Reject signals where `documentId` matches known synthetic/test docs
- Reject signals with `timeToCorrection < 500ms` (bot-speed, not human)

### Anonymization

- Strip session IDs after pipeline processing
- Context tokens: remove any tokens that are themselves PII (check against the doc's entity map)
- Never store the entity value that was revealed — only the correction type + context

### Enrichment

- Tag with document type (if inferrable from template or upload filename)
- Tag with entity frequency in document (rare vs. repeated entity)
- Tag with detection confidence bucket (high/medium/low if model provides it)

### Storage Schema

```sql
training_signals (
  id            UUID PRIMARY KEY,
  document_hash TEXT,          -- sha256
  entity_type   TEXT,          -- NAMES | FINANCIAL | ...
  entity_subtype TEXT,         -- GIVENNAME | SURNAME | ...
  correction    TEXT,          -- FALSE_POSITIVE | FALSE_NEGATIVE | CONFIRMED
  context_pre   JSONB,         -- preceding tokens array
  context_post  JSONB,         -- following tokens array
  model_version TEXT,
  doc_type      TEXT,
  confidence    FLOAT,
  created_at    TIMESTAMPTZ,

  -- Aggregation flags (set by pipeline)
  is_deduplicated BOOLEAN DEFAULT false,
  batch_id        TEXT         -- which training batch this fed into
)
```

---

## Layer 3: Training Loop

### When to Train

Not continuously — training on noise is worse than not training. Gate on:

| Trigger           | Condition                                         |
| ----------------- | ------------------------------------------------- |
| Signal volume     | 500+ new signals since last training run          |
| Error rate spike  | FP rate > 15% on any entity subtype               |
| New document type | Template with new `documentType` reaches 20+ uses |
| Weekly cadence    | Regardless of volume, every Sunday at 2am         |

### Training Approaches (choose by current architecture)

#### Option A: Prompt-Based Detection (if using LLM for detection)

Use signals to improve the system prompt. The training loop generates prompt updates:

```
Current prompt: "Detect names, financial info, contact details, identifiers, locations."

Signal analysis shows: 85% FP rate on "March" (detected as GIVENNAME)
                       22% FP rate on "Blue Cross" (sometimes detected as NAME)
                       12% FN rate on policy number prefixes ("BC-", "AC-")

Proposed prompt update:
  - Add: "Month names (January, February, March...) are NOT given names."
  - Add: "Insurance provider names (Blue Cross, Aetna, UnitedHealth) are IDENTIFIERS, not NAMES."
  - Add: "Policy number prefixes like 'BC-', 'AC-' should be included as part of the IDENTIFIER entity."
```

Evaluate the updated prompt on a held-out labeled set before deploying.

#### Option B: Fine-Tuned NER Model (if using dedicated NER)

1. Convert signals to CoNLL/BIO format training examples
2. Fine-tune on corrected examples (weighted: FP/FN corrections weighted 3x vs CONFIRMED)
3. Evaluate on canonical test set — require F1 improvement ≥ 1% to promote
4. A/B test at 10% traffic for 48h before full rollout

#### Option C: Hybrid (recommended for Pre-Redact's stage)

- Use LLM-based detection with a **rule layer on top**
- Rules encode high-confidence patterns learned from signals
- Signals feed rule generation + prompt refinement (no GPU/fine-tuning needed to start)
- Graduate to fine-tuned model when labeled corpus reaches 10k+ examples

```
Signal → Rule Generator → New Rules
  e.g., "March" FP on 847 documents →
  Rule: token("March") preceded by "on|in|by|during" → DATE, not GIVENNAME
```

### Evaluation — Canonical Test Set

Maintain a locked test set of 50 documents with gold-standard entity labels.
Sources: synthetic docs, public domain medical/legal docs with hand-labeled PII.

**Metrics to track (per entity subtype):**

- Precision (FP rate inverse)
- Recall (FN rate inverse)
- F1
- Exact match vs. boundary match (did we get the right span?)

**Regression gate:** New model/prompt must not regress F1 by more than 0.5% on any subtype.

---

## Layer 4: Deployment & Monitoring

### Rollout Strategy

1. Shadow mode: run new model alongside old, log differences (don't show new results yet)
2. 10% rollout: show new results to 10% of sessions, capture signal rate
3. Full rollout if: FP rate ≤ old model AND FN rate ≤ old model after 48h
4. Instant rollback trigger: FP rate rises > 5% above baseline in any 1-hour window

### Metrics Dashboard (track these)

| Metric                      | Target | Alert if                |
| --------------------------- | ------ | ----------------------- |
| Overall FP rate             | < 5%   | > 10%                   |
| Overall FN rate             | < 8%   | > 15%                   |
| Names FP rate               | < 3%   | > 8%                    |
| Financial FP rate           | < 2%   | > 5%                    |
| Time-to-correction (median) | > 3s   | < 1s (bot activity?)    |
| Signals per session         | 0-2    | > 5 (model degradation) |
| CONFIRMED sessions (%)      | > 70%  | < 50%                   |

### Drift Detection

- Monitor signal distribution over time
- Alert if a new document type appears with high error rates (new domain the model hasn't seen)
- Alert if a previously reliable entity subtype starts spiking FPs (upstream data change)

---

## Document-Type-Aware Detection

This is the biggest accuracy lever after the basic loop.

### Problem

A single model trained on all document types performs mediocre on all of them.
A model that knows it's looking at a medical letter vs. an aircraft operating agreement
will dramatically outperform on both.

### Implementation

1. **Document type classifier** (lightweight, runs first):
   - Input: first 200 tokens of document
   - Output: `medical | legal | financial | contract | hr | other`
   - Can be a simple prompt: "What type of document is this? Respond with one word."

2. **Type-specific detection rules** (augment the base model):

   ```
   medical:   prioritize GIVENNAME, SURNAME, DATE, TELEPHONE, EMAIL, SOCIALNUMB, ACCOUNTNUM
              watch for: doctor titles, medication names (not PII), condition names (not PII)

   legal/contract: prioritize COMPANY, PERSON, DATE, IDENTIFIER, CURRENCY, LOCATION
                   watch for: party labels ("Operator", "Client") that prefix real entity names

   financial: prioritize ACCOUNTNUM, CURRENCY, SOCIALNUMB, ROUTING, DATE
              watch for: amounts that aren't account numbers
   ```

3. **Templates as type signals**: when a user saves a template, they're implicitly labeling the document type. Harvest this.

---

## What to Build First (Sequenced)

### Phase 1 (Now — 2 weeks)

- [ ] Signal capture events in the app (toggle, add, confirm)
- [ ] Signal storage (even just a DB table or append-only log)
- [ ] Admin dashboard: FP/FN rates per entity type, per week

### Phase 2 (Month 1)

- [ ] Canonical test set: 50 labeled documents
- [ ] Weekly batch: aggregate signals → generate rule updates → evaluate
- [ ] Prompt refinement loop (manual review of suggested updates before deploy)

### Phase 3 (Month 2-3)

- [ ] Automated rule generation from signal clusters
- [ ] Document type classifier
- [ ] Type-aware detection layer
- [ ] A/B testing infrastructure for model rollout

### Phase 4 (Month 3+)

- [ ] Fine-tuned NER model (when labeled corpus is large enough)
- [ ] Real-time drift detection + alerting
- [ ] Shadow mode rollout for new model versions

---

## Why This Beats Most Training Pipelines

| Typical NER Training            | Pre-Redact Self-Training                                         |
| ------------------------------- | ---------------------------------------------------------------- |
| Annotators label synthetic data | Real users correct real documents                                |
| One-time training run           | Continuous improvement loop                                      |
| Generic entity types            | Domain-specific subtypes (ACCOUNTNUM, SOCIALNUMB, TELEPHONENUMB) |
| No deployment feedback          | User corrections ARE the feedback                                |
| Expensive to scale              | Gets better as product grows                                     |
| Cold start problem              | Every correction improves next user's experience                 |

The compounding effect: more users → more signals → better detection → fewer corrections needed → more confident users → more users.
