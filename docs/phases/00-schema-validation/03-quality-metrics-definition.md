# Phase 0, Task 03: Quality Metrics Definition

**Phase:** 0 - Schema Validation & Ground Truth
**Task:** Define quality metrics and targets for entity extraction
**Duration:** 0.5 day
**Complexity:** Low

---

## Task Overview

Define measurable quality metrics and targets for the entity extraction pipeline. These metrics will be used to validate that the automated extraction meets quality standards before proceeding to Phase 1.

## Metrics to Define

### 1. Entity Extraction Metrics

#### Entity Precision
- **Definition:** Of all entities extracted, how many are correct?
- **Formula:** `True Positives / (True Positives + False Positives)`
- **Target:** ≥0.85 (85%)
- **Rationale:** High precision prevents graph pollution from spurious entities

#### Entity Recall
- **Definition:** Of all entities in ground truth, how many were found?
- **Formula:** `True Positives / (True Positives + False Negatives)`
- **Target:** ≥0.80 (80%)
- **Rationale:** Good recall ensures comprehensive coverage

#### Entity F1 Score
- **Definition:** Harmonic mean of precision and recall
- **Formula:** `2 * (Precision * Recall) / (Precision + Recall)`
- **Target:** ≥0.82 (balanced)

#### Entity Type Accuracy
- **Definition:** Of correctly identified entities, how many have correct type?
- **Formula:** `Correct Types / Total Correct Entities`
- **Target:** ≥0.90 (90%)
- **Rationale:** Type correctness is critical for graph queries

### 2. Relationship Extraction Metrics

#### Relationship Precision
- **Definition:** Of all relationships extracted, how many are correct?
- **Formula:** `True Positives / (True Positives + False Positives)`
- **Target:** ≥0.75 (75%)
- **Rationale:** Relationships are noisier; we accept some false positives

#### Relationship Recall
- **Definition:** Of all relationships in ground truth, how many were found?
- **Formula:** `True Positives / (True Positives + False Negatives)`
- **Target:** ≥0.70 (70%)
- **Rationale:** Relationship extraction is harder; lower target acceptable

#### Relationship Type Accuracy
- **Definition:** Of correctly identified relationships, how many have correct type?
- **Formula:** `Correct Types / Total Correct Relationships`
- **Target:** ≥0.80 (80%)

#### Relationship Strength Correlation
- **Definition:** How well extracted strength matches ground truth?
- **Formula:** `1 - (|ExtractedStrength - GroundTruthStrength| / 10)`
- **Target:** ≥0.70 (70% correlation)
- **Rationale:** Strength affects graph traversal relevance

### 3. Consolidation Metrics

#### False Merge Rate
- **Definition:** How often distinct entities are incorrectly merged?
- **Formula:** `False Merges / Total Merges`
- **Target:** ≤0.05 (5%)
- **Rationale:** False merges corrupt the graph; must be rare

#### Missed Merge Rate
- **Definition:** How often duplicate entities are not merged?
- **Formula:** `Missed Merges / Total Should-Merge Pairs`
- **Target:** ≤0.15 (15%)
- **Rationale:** Some duplicates acceptable; they can be merged later

#### Alias Detection Rate
- **Definition:** How well are aliases captured?
- **Formula:** `Detected Aliases / Total Ground Truth Aliases`
- **Target:** ≥0.75 (75%)

### 4. Description Quality Metrics

#### Description Completeness
- **Definition:** What percentage of entities have descriptions?
- **Formula:** `Entities with Descriptions / Total Entities`
- **Target:** ≥0.90 (90%)

#### Description Accuracy
- **Definition:** Manual assessment of description correctness
- **Target:** ≥85% rated "accurate" or "mostly accurate"
- **Method:** Sample 50 random descriptions, rate 1-5

## Ground Truth Matching Rules

### Entity Matching

An extracted entity matches ground truth if:

1. **Name Match (exact):** Normalized names are identical
   - Normalization: lowercase, trim whitespace, remove punctuation
   - Example: "Auth Service" == "auth service" == "AuthService"

2. **Name Match (alias):** Extracted name is in ground truth aliases
   - Example: Extracted "Auth Service" matches entity with alias "AuthService"

3. **Overlap Match:** Names overlap significantly (≥80% character similarity)
   - Example: "PaymentHandler" matches "Payment Handler"
   - Used for fuzzy matching evaluation

### Relationship Matching

An extracted relationship matches ground truth if:

1. **Triple Match:** (source, target, type) all match
   - Source entity matches (per entity rules above)
   - Target entity matches
   - Relationship type matches (exact or synonym)

2. **Directional:** Must respect direction
   - "A depends_on B" ≠ "B depends_on A"
   - Unless relationship type is undirected (e.g., "related_to")

## Evaluation Script Specification

Create file: `src/knowledge/quality/evaluate-extraction.ts`

```typescript
interface EvaluationResult {
  entityMetrics: {
    precision: number;
    recall: number;
    f1Score: number;
    typeAccuracy: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
  };
  relationshipMetrics: {
    precision: number;
    recall: number;
    f1Score: number;
    typeAccuracy: number;
    strengthCorrelation: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
  };
  consolidationMetrics: {
    falseMergeRate: number;
    missedMergeRate: number;
    aliasDetectionRate: number;
  };
  descriptionQuality: {
    completeness: number;
    accuracySamples: {
      total: number;
      accurate: number;
      mostlyAccurate: number;
      partiallyAccurate: number;
      inaccurate: number;
    };
  };
}

export async function evaluateExtraction(
  extracted: ExtractionResult[],
  groundTruth: GroundTruthExtraction[]
): Promise<EvaluationResult> {
  // Implementation
}
```

## Phase 0 Exit Criteria

The extraction pipeline **must meet all targets** before proceeding to Phase 1:

### Minimum Requirements
- [ ] Entity F1 Score ≥ 0.82
- [ ] Entity Type Accuracy ≥ 0.90
- [ ] Relationship F1 Score ≥ 0.72
- [ ] False Merge Rate ≤ 0.05
- [ ] Description Completeness ≥ 0.90

### Quality Gates

If metrics **do not meet targets**:

1. **Analyze failure mode:**
   - Low precision → Adjust consolidation thresholds
   - Low recall → Improve extraction prompts
   - Low type accuracy → Add few-shot examples

2. **Iterate on prompts:**
   - Add domain-specific examples
   - Clarify type definitions
   - Adjust delimiter format

3. **Re-evaluate:**
   - Run extraction on test corpus
   - Compare to ground truth
   - Repeat until targets met

## Benchmark Documentation

After initial evaluation, document baseline results in:

**File:** `src/knowledge/quality/baseline-metrics.json`

```json
{
  "evaluatedAt": "2024-01-26T10:00:00Z",
  "model": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "promptVersion": "v1"
  },
  "corpus": {
    "documents": 10,
    "totalWords": 2500,
    "groundTruthEntities": 125,
    "groundTruthRelationships": 95
  },
  "results": {
    "entityMetrics": {
      "precision": 0.00,
      "recall": 0.00,
      "f1Score": 0.00,
      "typeAccuracy": 0.00
    },
    "relationshipMetrics": {
      "precision": 0.00,
      "recall": 0.00,
      "f1Score": 0.00,
      "typeAccuracy": 0.00
    },
    "consolidationMetrics": {
      "falseMergeRate": 0.00,
      "missedMergeRate": 0.00,
      "aliasDetectionRate": 0.00
    }
  },
  "targetsMet": false,
  "recommendations": []
}
```

## Success Criteria

Phase 0 is complete when:

- [ ] Test corpus created (Task 01)
- [ ] Ground truth extraction completed (Task 02)
- [ ] Quality metrics defined (this task)
- [ ] Evaluation script implemented
- [ ] Baseline metrics measured
- [ ] All minimum requirements met OR improvements documented

## References

- Ground Truth Schema: Task 02 (`02-manual-entity-extraction.md`)
- Consolidation Algorithm: `docs/plans/graphrag/ZAI-FINAL-DECISIONS.md` section "3-Tier Entity Consolidation"
- Quality Validation Plan: `docs/plans/graphrag/ZAI-PLAN.md` Phase 7

## Phase 0 Complete

After completing this task, Phase 0 (Schema Validation & Ground Truth) is complete. Proceed to **Phase 1: Graph Storage + Entity Extraction Core**.

**Next Phase:** `docs/phases/01-foundation/01-datastore-interface.md`
