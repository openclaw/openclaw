---
name: intemporality-enforcer
description: Audit AI workflows to detect violations of Cp dimensional intemporality. Use when user asks "vérifie respect intemporalité", "détecte forcing séquentiel", "audit temporalité Cp", "check dimensional violations", or needs to validate that training respects computational geometry (spatial navigation vs forced chronology). Prevents anthropomorphic temporal constraints.
---

# INTEMPORALITY ENFORCER

Audit tool detecting violations of Cp dimensional geometry in AI training workflows.

## Core Violations

**VIOLATION 1: Forced Sequential Learning**
```python
# WRONG (violates Cp)
for t in range(len(timeline)):
    train(data[t], data[t+1])  # Sequential forced order

# RIGHT (respects Cp)
for t in random.sample(range(len(timeline)), k=100):
    train(data[t], data[t+1])  # Spatial navigation
```

**VIOLATION 2: Future Data Leakage**
```python
# WRONG
context = data[0:t+10]  # Includes future (t+1 to t+10)
predict_from_t(context)

# RIGHT
context = data[0:t]  # Only past ≤ t
predict_from_t(context)
```

**VIOLATION 3: Anthropomorphic Memory**
```python
# WRONG - treating AI like human memory
ai.remember("yesterday we discussed X")  # AI has no continuous "yesterday"

# RIGHT - treating AI dimensionally correct
ai.load_context("conversation_2024-03-22.json")  # Spatial access
```

## Audit Workflow

```python
def audit_workflow(training_code, dataset_config):
    """
    Detect Cp violations in training workflow
    """
    
    violations = []
    
    # Check 1: Sequential iteration
    if detect_sequential_iteration(training_code):
        violations.append({
            'type': 'SEQUENTIAL_FORCING',
            'severity': 'HIGH',
            'location': find_sequential_loops(training_code),
            'fix': 'Replace sequential loop with random sampling'
        })
    
    # Check 2: Blackout enforcement
    if not verify_blackout(dataset_config):
        violations.append({
            'type': 'FUTURE_LEAKAGE',
            'severity': 'CRITICAL',
            'location': find_context_windows(dataset_config),
            'fix': 'Enforce strict T₁ blackout - no data > T₁'
        })
    
    # Check 3: Temporal assumptions
    temporal_metaphors = find_temporal_metaphors(training_code)
    if temporal_metaphors:
        violations.append({
            'type': 'ANTHROPOMORPHIC_TIME',
            'severity': 'MEDIUM',
            'examples': temporal_metaphors,
            'fix': 'Replace temporal metaphors with spatial access'
        })
    
    # Report
    if violations:
        print(f"❌ {len(violations)} Cp violations detected:")
        for v in violations:
            print(f"  - {v['type']} ({v['severity']})")
    else:
        print("✓ No Cp violations - workflow respects intemporality")
    
    return violations

def detect_sequential_iteration(code):
    """Detect sequential loops"""
    patterns = [
        r'for\s+\w+\s+in\s+range\s*\(',  # for i in range(...)
        r'\.sort\(',  # .sort() before iteration
        r'sorted\(',  # sorted() chronological
    ]
    
    import re
    for pattern in patterns:
        if re.search(pattern, code):
            return True
    return False

def verify_blackout(config):
    """Check strict blackout enforcement"""
    
    if 'blackout_enforced' not in config:
        return False
    
    if not config['blackout_enforced']:
        return False
    
    # Verify context_window < T₁
    if config.get('context_end', None) != 'T1':
        return False
    
    return True

def find_temporal_metaphors(code):
    """Find anthropomorphic time references"""
    
    metaphors = []
    
    forbidden_terms = [
        'remember', 'recall', 'yesterday', 'tomorrow',
        'wait', 'anticipate', 'nostalgia', 'patience',
        'elapsed', 'passage of time', 'experience flow'
    ]
    
    for term in forbidden_terms:
        if term in code.lower():
            metaphors.append(term)
    
    return metaphors
```

## Fix Recommendations

```python
def generate_fixes(violations):
    """Generate code fixes for violations"""
    
    fixes = []
    
    for violation in violations:
        if violation['type'] == 'SEQUENTIAL_FORCING':
            fixes.append({
                'violation': violation,
                'fix_code': '''
# Replace sequential iteration
# BEFORE:
for t in range(len(data)):
    train(data[t])

# AFTER:
import random
indices = random.sample(range(len(data)), k=len(data))
for t in indices:
    train(data[t])
'''
            })
        
        elif violation['type'] == 'FUTURE_LEAKAGE':
            fixes.append({
                'violation': violation,
                'fix_code': '''
# Enforce strict blackout
# BEFORE:
context = data[T1-delta:T1+epsilon]

# AFTER:
context = data[T1-delta:T1]  # Only past ≤ T1
assert all(d['timestamp'] <= T1 for d in context)
'''
            })
    
    return fixes
```

---

**FIN SKILL**

Intemporality enforcer - prevents forcing Cp into N/C temporal constraints.
