---
name: intervention-router
description: Diagnose which level of a system a problem belongs to before intervening. Use for "diagnostique niveau problème", "where should I fix this", "wrong level intervention", "root cause layer", "mismatched fix", or any situation where applying a fix at the wrong level wastes resources or worsens things. Universal pattern for debugging, management, optimization, troubleshooting, incident response. Prevents structural fixes for operational problems and vice versa.
---

# INTERVENTION ROUTER

Universal problem-to-level routing. Diagnose before you fix.

## Core Pattern

```python
def route_intervention(problem, levels, probe_fn):
    """
    Determine which system level a problem belongs to.
    
    Args:
        problem: Description or symptoms of the issue
        levels: List of {name, description, probe, fix_cost, fix_speed}
            ordered from deepest/slowest to shallowest/fastest
        probe_fn: callable(problem, level) → confidence (0-1)
        
    Returns:
        diagnosed_level: which level to intervene at
        confidence: how sure we are
        report: full diagnostic with warnings
    """
    
    diagnoses = []
    for level in levels:
        confidence = probe_fn(problem, level)
        diagnoses.append({
            'level': level['name'],
            'confidence': confidence,
            'fix_cost': level.get('fix_cost', 'unknown'),
            'fix_speed': level.get('fix_speed', 'unknown'),
        })
    
    # Primary diagnosis = highest confidence
    primary = max(diagnoses, key=lambda d: d['confidence'])
    
    # Check for multi-level problems
    significant = [d for d in diagnoses if d['confidence'] > 0.4]
    multi_level = len(significant) > 1
    
    # Mismatch warning: cheapest fix vs actual level
    cheapest = min(diagnoses, key=lambda d: d.get('fix_cost', float('inf')))
    mismatch_risk = (cheapest['level'] != primary['level'] 
                     and cheapest['confidence'] < 0.3)
    
    return primary['level'], primary['confidence'], {
        'all_diagnoses': diagnoses,
        'multi_level': multi_level,
        'significant_levels': [d['level'] for d in significant],
        'mismatch_warning': mismatch_risk,
        'recommendation': _recommend(primary, significant, multi_level)
    }


def _recommend(primary, significant, multi_level):
    if multi_level:
        return (f"Problem spans multiple levels: "
                f"{[d['level'] for d in significant]}. "
                f"Fix {primary['level']} first (highest confidence), "
                f"then re-diagnose.")
    return f"Intervene at {primary['level']}."
```

## Anti-Pattern: Wrong Level Fix

```
Problem: "App is slow"

❌ Wrong routing:
   Symptom → slow → rewrite codebase (structural fix)
   Actual cause → misconfigured cache (operational fix)
   Cost: weeks wasted

✓ Correct routing:
   Probe infrastructure level → confidence 0.2
   Probe code level → confidence 0.3
   Probe config level → confidence 0.85
   → Fix config first, re-diagnose if needed
```

## Example: Software Debugging

```python
levels = [
    {'name': 'architecture', 'fix_cost': 10, 'fix_speed': 'weeks',
     'description': 'System design, data model, core abstractions'},
    {'name': 'implementation', 'fix_cost': 5, 'fix_speed': 'days',
     'description': 'Code logic, algorithms, error handling'},
    {'name': 'configuration', 'fix_cost': 1, 'fix_speed': 'minutes',
     'description': 'Settings, env vars, feature flags, permissions'},
]

level, confidence, report = route_intervention(
    problem="API returns 500 after deploy",
    levels=levels,
    probe_fn=check_symptoms_against_level
)
```

## Example: Team Performance Issue

```python
levels = [
    {'name': 'organizational', 'fix_cost': 10, 'fix_speed': 'months',
     'description': 'Org structure, incentives, culture'},
    {'name': 'process', 'fix_cost': 5, 'fix_speed': 'weeks',
     'description': 'Workflows, tools, communication patterns'},
    {'name': 'individual', 'fix_cost': 2, 'fix_speed': 'days',
     'description': 'Skills, motivation, workload of specific people'},
]

level, confidence, report = route_intervention(
    problem="Missed deadlines three sprints in a row",
    levels=levels,
    probe_fn=analyze_team_symptoms
)
# Maybe it's process (bad estimation), not individual (lazy devs)
```

## Example: ML Model Underperformance

```python
levels = [
    {'name': 'data', 'fix_cost': 8, 'fix_speed': 'weeks',
     'description': 'Training data quality, distribution, labeling'},
    {'name': 'architecture', 'fix_cost': 6, 'fix_speed': 'days',
     'description': 'Model design, capacity, layer structure'},
    {'name': 'training', 'fix_cost': 3, 'fix_speed': 'hours',
     'description': 'Hyperparameters, learning rate, batch size'},
    {'name': 'inference', 'fix_cost': 1, 'fix_speed': 'minutes',
     'description': 'Serving config, batching, preprocessing'},
]

level, confidence, report = route_intervention(
    problem="Model accuracy dropped 5% after retrain",
    levels=levels,
    probe_fn=ml_diagnostic
)
```

## Key Properties

- **Diagnose first**: Never skip to the cheapest/fastest fix without probing
- **Depth ordering**: Levels go from deep/slow/expensive to shallow/fast/cheap
- **Multi-level detection**: Some problems span levels — fix deepest first, re-diagnose
- **Mismatch warning**: Flags when the tempting quick fix doesn't match the actual problem
- **Re-diagnose loop**: After fixing one level, run again — the problem may have shifted

---

**FIN SKILL**
