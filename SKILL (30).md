---
name: bottleneck-identifier
description: Find the weakest component limiting overall system performance. Use for "trouve le goulot", "bottleneck analysis", "maillon faible", "what's limiting performance", "where's the constraint", or any system where total output = min(components). Universal pattern for supply chains, ML pipelines, team performance, infrastructure, manufacturing, project management.
---

# BOTTLENECK IDENTIFIER

Universal weakest-link detection across multi-component systems.

## Core Pattern

```python
def find_bottleneck(components, measure_fn, dependency_map=None):
    """
    Identify the component limiting overall system performance.
    
    Args:
        components: Dict of {name: component}
        measure_fn: callable(component) → score (0-1)
        dependency_map: Optional dict {name: [depends_on]} for chain analysis
        
    Returns:
        bottleneck: name of weakest component
        scores: all component scores
        report: analysis with improvement priority
    """
    
    scores = {}
    for name, component in components.items():
        scores[name] = measure_fn(component)
    
    # System performance = min(components)
    bottleneck = min(scores, key=scores.get)
    system_score = scores[bottleneck]
    
    # Improvement priority = gap between component and next-weakest
    sorted_scores = sorted(scores.items(), key=lambda x: x[1])
    
    priority_queue = []
    for i, (name, score) in enumerate(sorted_scores):
        # How much system improves if this component reaches next level
        next_score = sorted_scores[i + 1][1] if i + 1 < len(sorted_scores) else 1.0
        headroom = next_score - score
        priority_queue.append({
            'component': name,
            'score': score,
            'headroom': headroom,
            'is_bottleneck': name == bottleneck
        })
    
    # Chain analysis if dependencies exist
    critical_path = None
    if dependency_map:
        critical_path = find_critical_path(scores, dependency_map)
    
    return bottleneck, scores, {
        'system_score': system_score,
        'priority_queue': priority_queue,
        'critical_path': critical_path,
        'spread': max(scores.values()) - min(scores.values())
    }


def find_critical_path(scores, dependency_map):
    """Find the dependency chain with lowest cumulative score."""
    
    def chain_score(node, visited=None):
        if visited is None:
            visited = set()
        if node in visited:
            return float('inf')  # cycle protection
        visited.add(node)
        
        deps = dependency_map.get(node, [])
        if not deps:
            return scores[node]
        
        return min(
            scores[node],
            min(chain_score(d, visited.copy()) for d in deps)
        )
    
    # Score each terminal node's full chain
    terminals = [n for n in scores if n not in 
                 {d for deps in dependency_map.values() for d in deps}]
    
    paths = {t: chain_score(t) for t in terminals}
    critical = min(paths, key=paths.get)
    
    return {'terminal': critical, 'chain_score': paths[critical]}
```

## Example: ML Pipeline

```python
components = {
    'data_quality': data_pipeline,
    'model_architecture': model,
    'training_compute': gpu_cluster,
    'eval_coverage': test_suite,
    'deployment': serving_infra,
}

bottleneck, scores, report = find_bottleneck(
    components, 
    measure_fn=benchmark_component
)

# "Your bottleneck is data_quality (0.45). 
#  Fixing it to 0.72 (next weakest) unlocks 0.27 headroom."
```

## Example: Team Performance

```python
components = {
    'hiring': recruiting_metrics,
    'onboarding': ramp_time,
    'tooling': developer_experience,
    'processes': cycle_time,
    'retention': turnover_rate,
}

bottleneck, scores, report = find_bottleneck(
    components,
    measure_fn=score_team_dimension
)
```

## Example: Supply Chain

```python
components = {
    'supplier_reliability': supplier,
    'manufacturing_capacity': factory,
    'logistics': shipping,
    'inventory_management': warehouse,
    'demand_forecasting': forecast_model,
}

bottleneck, scores, report = find_bottleneck(
    components,
    measure_fn=throughput_score,
    dependency_map={
        'manufacturing_capacity': ['supplier_reliability'],
        'logistics': ['manufacturing_capacity'],
        'inventory_management': ['logistics', 'demand_forecasting'],
    }
)
```

## Key Properties

- **Min-function**: System output = weakest component, not average
- **Headroom**: Quantifies how much fixing the bottleneck actually gains
- **Priority queue**: Ordered fix list — don't optimize what isn't limiting
- **Chain-aware**: With dependencies, finds the critical path not just the weakest node
- **Spread metric**: Large spread = severe imbalance, small = well-balanced system

---

**FIN SKILL**
