---
name: multi-axis-validator
description: Validate any candidate (idea, output, decision, data, hire, investment) across N orthogonal axes with configurable thresholds. Use for "valide sur plusieurs axes", "multi-criteria evaluation", "orthogonal validation", "check quality on multiple dimensions", "gate decision", or any workflow requiring structured multi-dimensional pass/fail. Universal pattern for quality gates, review processes, go/no-go decisions.
---

# MULTI-AXIS VALIDATOR

Universal N-axis orthogonal validation with configurable thresholds.

## Core Pattern

```python
def validate(candidate, axes, mode='standard'):
    """
    Validate candidate across orthogonal axes.
    
    Args:
        candidate: Thing to validate (any type)
        axes: List of {name, evaluator, threshold}
        mode: Preset threshold profile or 'custom'
        
    Returns:
        passed: bool, scores: dict, report: dict
    """
    
    MODES = {
        'exploratory': 0.6,   # tolerant — brainstorm, early stage
        'standard': 0.7,      # balanced — normal operations
        'strict': 0.85,       # rigorous — production, critical decisions
        'absolute': 0.95      # near-certain — safety, legal, medical
    }
    
    default_threshold = MODES.get(mode, 0.7)
    
    scores = {}
    for axis in axes:
        threshold = axis.get('threshold', default_threshold)
        score = axis['evaluator'](candidate)
        scores[axis['name']] = {
            'score': score,
            'threshold': threshold,
            'passed': score >= threshold
        }
    
    all_passed = all(s['passed'] for s in scores.values())
    
    return all_passed, scores, {
        'mode': mode,
        'pass_count': sum(1 for s in scores.values() if s['passed']),
        'total_axes': len(axes),
        'weakest': min(scores, key=lambda k: scores[k]['score']),
        'strongest': max(scores, key=lambda k: scores[k]['score'])
    }
```

## Validation Rule

```
candidate passes ⟺ ∀ axis_i : score_i ≥ threshold_i
```

One axis below threshold = reject. No averaging, no compensation between axes.

## Example: Code Review

```python
axes = [
    {'name': 'correctness', 'evaluator': run_tests, 'threshold': 0.95},
    {'name': 'readability', 'evaluator': lint_score, 'threshold': 0.7},
    {'name': 'performance', 'evaluator': benchmark, 'threshold': 0.8},
    {'name': 'security', 'evaluator': security_scan, 'threshold': 0.9},
]

passed, scores, report = validate(pull_request, axes, mode='strict')

if not passed:
    print(f"Blocked — weakest axis: {report['weakest']}")
```

## Example: Hiring Decision

```python
axes = [
    {'name': 'technical', 'evaluator': interview_score},
    {'name': 'culture_fit', 'evaluator': team_feedback},
    {'name': 'growth_potential', 'evaluator': ref_check},
]

passed, scores, report = validate(candidate, axes, mode='standard')
```

## Example: Investment Screening

```python
axes = [
    {'name': 'market_size', 'evaluator': tam_analysis},
    {'name': 'team_quality', 'evaluator': founder_eval},
    {'name': 'unit_economics', 'evaluator': financial_model},
    {'name': 'defensibility', 'evaluator': moat_analysis},
]

passed, scores, report = validate(startup, axes, mode='strict')
```

## Key Properties

- **Orthogonality**: Axes must be independent — scoring high on one shouldn't predict scoring high on another
- **No compensation**: A 1.0 on axis A doesn't compensate a 0.4 on axis B
- **Mode switching**: Same axes, different thresholds depending on context
- **Weakest link reporting**: Always surface which axis failed first

---

**FIN SKILL**
