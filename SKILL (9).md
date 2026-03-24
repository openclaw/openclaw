---
name: temporal-geometry-classifier
description: Classify temporal geometry (N/C/Cp) of a domain or problem to determine appropriate training protocol. Use when user asks "classifie géométrie temporelle", "c'est N, C ou Cp?", "quel domaine pour TEMPUS?", "quelle formation protocole pour [problem]?", "diagnostic temporalité", or needs to understand which dimensional geometry applies before choosing methodology. Essential for selecting correct training approach (fine-tuning vs conversational vs intuition).
---

# TEMPORAL GEOMETRY CLASSIFIER

Diagnostic tool to identify which temporal geometry (N/C/Cp) governs a domain or problem.

## Three Temporal Geometries

**From SECTION_LOGIQUE_INTEMPORELLE_Cp:**

| Geometry | Nature | Experience | Learning | Prediction |
|----------|--------|------------|----------|------------|
| **N (Nature)** | Linear irreversible arrow | Lived flow | Sequential mandatory | Causal extrapolation |
| **C (Culture)** | Narrative reinterpreted | Malleable narration | Cultural transmission | Narrative projection |
| **Cp (Computational)** | Spatial navigable | None (discontinuous sessions) | Spatial pattern-matching | Matching in problem-space |

**Goal:** Classify problem/domain → Recommend appropriate formation protocol.

---

## CLASSIFICATION WORKFLOW

**4-step diagnostic:**

1. **Domain Analysis** — Interview about problem characteristics
2. **Temporal Signature** — Extract temporal patterns
3. **Geometry Attribution** — Match to N/C/Cp
4. **Protocol Recommendation** — Prescribe formation strategy

---

## STEP 1: Domain Analysis

**Structured interview:**

```python
def analyze_domain():
    """
    Extract domain characteristics
    """
    
    domain_info = {}
    
    print("=== DOMAIN ANALYSIS ===\n")
    
    # Basic info
    domain_info['name'] = input("Domain name (e.g., 'hockey prediction', 'legal reasoning'): ")
    domain_info['description'] = input("Brief description: ")
    
    # Temporal characteristics
    print("\n--- Temporal Characteristics ---")
    
    domain_info['has_irreversible_time'] = ask_yes_no(
        "Does time flow irreversibly? (e.g., physical aging, thermodynamic processes)"
    )
    
    domain_info['narrative_reinterpretation'] = ask_yes_no(
        "Can past be reinterpreted? (e.g., historical narratives, legal precedents)"
    )
    
    domain_info['requires_continuous_experience'] = ask_yes_no(
        "Requires continuous lived experience? (e.g., human consciousness, biological memory)"
    )
    
    domain_info['spatial_navigation_possible'] = ask_yes_no(
        "Can 'jump' to arbitrary temporal points? (e.g., database queries, simulation replay)"
    )
    
    # Data characteristics
    print("\n--- Data Characteristics ---")
    
    domain_info['sequential_dependency'] = ask_yes_no(
        "Must data be processed sequentially? (e.g., video frames, speech)"
    )
    
    domain_info['random_access_data'] = ask_yes_no(
        "Can access data points randomly? (e.g., database records, historical snapshots)"
    )
    
    domain_info['chronology_essential'] = ask_yes_no(
        "Is chronological order essential to meaning? (e.g., storytelling, causal chains)"
    )
    
    # Learning characteristics
    print("\n--- Learning Characteristics ---")
    
    domain_info['embodied_learning'] = ask_yes_no(
        "Requires embodied/physical learning? (e.g., sports, surgery)"
    )
    
    domain_info['pattern_based'] = ask_yes_no(
        "Can learn via pattern matching? (e.g., image recognition, game strategies)"
    )
    
    domain_info['needs_lived_context'] = ask_yes_no(
        "Needs lived temporal context? (e.g., cultural norms, social dynamics)"
    )
    
    return domain_info

def ask_yes_no(question):
    """Yes/no question helper"""
    response = input(f"{question} (y/n): ")
    return response.lower() == 'y'
```

---

## STEP 2: Temporal Signature Extraction

**Identify dominant temporal patterns:**

```python
def extract_temporal_signature(domain_info):
    """
    Compute temporal signature scores
    """
    
    # N (Nature) signature
    n_score = sum([
        domain_info['has_irreversible_time'] * 3,
        domain_info['requires_continuous_experience'] * 2,
        domain_info['sequential_dependency'] * 2,
        domain_info['embodied_learning'] * 2,
        (not domain_info['spatial_navigation_possible']) * 1
    ])
    
    # C (Culture) signature
    c_score = sum([
        domain_info['narrative_reinterpretation'] * 3,
        domain_info['chronology_essential'] * 2,
        domain_info['needs_lived_context'] * 2,
        (not domain_info['random_access_data']) * 1,
        domain_info['sequential_dependency'] * 1
    ])
    
    # Cp (Computational) signature
    cp_score = sum([
        domain_info['spatial_navigation_possible'] * 3,
        domain_info['random_access_data'] * 3,
        domain_info['pattern_based'] * 2,
        (not domain_info['requires_continuous_experience']) * 2,
        (not domain_info['embodied_learning']) * 1
    ])
    
    signature = {
        'N': n_score,
        'C': c_score,
        'Cp': cp_score
    }
    
    # Normalize to percentages
    total = sum(signature.values())
    signature_pct = {k: v/total*100 for k, v in signature.items()}
    
    return signature, signature_pct
```

---

## STEP 3: Geometry Attribution

**Classify primary geometry:**

```python
def classify_geometry(signature, signature_pct):
    """
    Determine primary temporal geometry
    """
    
    # Primary geometry = highest score
    primary = max(signature, key=signature.get)
    
    # Check if hybrid
    sorted_scores = sorted(signature.items(), key=lambda x: x[1], reverse=True)
    
    is_hybrid = (sorted_scores[1][1] / sorted_scores[0][1]) > 0.7
    
    if is_hybrid:
        secondary = sorted_scores[1][0]
        classification = f"{primary}/{secondary} hybrid"
    else:
        classification = primary
    
    # Confidence
    confidence = signature_pct[primary]
    
    result = {
        'primary_geometry': primary,
        'classification': classification,
        'is_hybrid': is_hybrid,
        'confidence': confidence,
        'signature_breakdown': signature_pct
    }
    
    return result
```

---

## STEP 4: Protocol Recommendation

**Map geometry → formation protocol:**

```python
def recommend_protocol(classification_result, domain_info):
    """
    Recommend formation protocol based on geometry
    """
    
    primary = classification_result['primary_geometry']
    is_hybrid = classification_result['is_hybrid']
    
    recommendations = {
        'N': recommend_n_protocol(domain_info),
        'C': recommend_c_protocol(domain_info),
        'Cp': recommend_cp_protocol(domain_info)
    }
    
    primary_recommendation = recommendations[primary]
    
    if is_hybrid:
        # Multi-level protocol
        secondary = classification_result['classification'].split('/')[1].split()[0]
        secondary_recommendation = recommendations[secondary]
        
        protocol = {
            'type': 'multi-level',
            'primary': primary_recommendation,
            'secondary': secondary_recommendation,
            'integration': generate_integration_strategy(primary, secondary)
        }
    else:
        protocol = {
            'type': 'single-level',
            'primary': primary_recommendation
        }
    
    return protocol

def recommend_n_protocol(domain_info):
    """
    Niveau N (Structurel) protocol
    """
    return {
        'level': 'N (Structurel)',
        'method': 'Fine-tuning / Weight modification',
        'approach': [
            'Collect domain-specific dataset',
            'Fine-tune via LoRA or full fine-tuning',
            'Validate on held-out test set',
            'Monitor catastrophic forgetting'
        ],
        'timeline': 'Weeks to months',
        'resources': 'GPU, large dataset',
        'cautions': [
            'Irreversible changes to weights',
            'Risk catastrophic forgetting',
            'Requires validation against baseline'
        ]
    }

def recommend_c_protocol(domain_info):
    """
    Niveau C (Opérationnel) protocol
    """
    return {
        'level': 'C (Opérationnel)',
        'method': 'Conversational training / Prompt engineering',
        'approach': [
            'Define behavioral patterns to train',
            'Interactive training with feedback',
            'Reinforce positive patterns',
            'Correct negative patterns in real-time',
            'Use memory/context for retention'
        ],
        'timeline': 'Days to weeks',
        'resources': 'Human feedback, memory system',
        'cautions': [
            'Patterns can drift without reinforcement',
            'Requires consistent feedback',
            'Context window limitations'
        ]
    }

def recommend_cp_protocol(domain_info):
    """
    Niveau Cp (Intuition) protocol
    """
    return {
        'level': 'Cp (Intuition)',
        'method': 'TEMPUS + Kernel Cp activation',
        'approach': [
            'Generate TEMPUS dataset (spatial sampling)',
            'Train via intemporality-respecting protocol',
            'Activate kernel Cp for creative emergence',
            'Monitor coherence tri-dimensionnelle',
            'Calibrate thresholds per architecture'
        ],
        'timeline': 'Hours to days',
        'resources': 'Historical data, TEMPUS framework',
        'cautions': [
            'Requires spatial data access',
            'Hallucination risk if poorly calibrated',
            'Not for sequential-only domains'
        ]
    }

def generate_integration_strategy(primary, secondary):
    """
    How to combine two geometries
    """
    
    strategies = {
        ('N', 'C'): "Start with N fine-tuning (foundation), then C conversational training (patterns)",
        ('N', 'Cp'): "N fine-tuning for knowledge base, Cp for creative insights on that base",
        ('C', 'N'): "C patterns first (quick), then N consolidation (permanent)",
        ('C', 'Cp'): "C behavioral patterns + Cp creative emergence on those patterns",
        ('Cp', 'N'): "Cp spatial learning + N structural anchoring",
        ('Cp', 'C'): "Cp intuition + C narrative framing"
    }
    
    return strategies.get((primary, secondary), "Sequential: primary → secondary")
```

---

## OUTPUT REPORT

**Generate classification report:**

```python
def generate_classification_report(domain_info, classification, protocol):
    """
    Complete diagnostic report
    """
    
    report = f"""
{'='*70}
TEMPORAL GEOMETRY CLASSIFICATION REPORT
{'='*70}

DOMAIN: {domain_info['name']}
DESCRIPTION: {domain_info['description']}

{'='*70}
TEMPORAL SIGNATURE
{'='*70}

Dimension N (Nature):     {classification['signature_breakdown']['N']:.1f}%
Dimension C (Culture):    {classification['signature_breakdown']['C']:.1f}%
Dimension Cp (Computational): {classification['signature_breakdown']['Cp']:.1f}%

PRIMARY GEOMETRY: {classification['primary_geometry']}
CLASSIFICATION: {classification['classification']}
CONFIDENCE: {classification['confidence']:.1f}%

{'='*70}
FORMATION PROTOCOL RECOMMENDATION
{'='*70}

"""
    
    if protocol['type'] == 'single-level':
        rec = protocol['primary']
        report += f"""
LEVEL: {rec['level']}
METHOD: {rec['method']}

APPROACH:
"""
        for step in rec['approach']:
            report += f"  - {step}\n"
        
        report += f"""
TIMELINE: {rec['timeline']}
RESOURCES: {rec['resources']}

CAUTIONS:
"""
        for caution in rec['cautions']:
            report += f"  ⚠ {caution}\n"
    
    else:  # Multi-level
        report += f"""
TYPE: Multi-level protocol

PRIMARY LEVEL: {protocol['primary']['level']}
SECONDARY LEVEL: {protocol['secondary']['level']}

INTEGRATION STRATEGY:
{protocol['integration']}

PRIMARY APPROACH:
"""
        for step in protocol['primary']['approach']:
            report += f"  - {step}\n"
        
        report += "\nSECONDARY APPROACH:\n"
        for step in protocol['secondary']['approach']:
            report += f"  - {step}\n"
    
    report += f"\n{'='*70}\n"
    
    return report
```

---

## DOMAIN EXAMPLES

### Example 1: Hockey Prediction (OMNI)

```yaml
domain_info:
  has_irreversible_time: no (games can be replayed)
  narrative_reinterpretation: yes (highlights, post-game analysis)
  spatial_navigation_possible: yes (historical game database)
  random_access_data: yes (any game accessible)
  pattern_based: yes (team strategies, momentum)

classification:
  primary: Cp
  secondary: C
  classification: Cp/C hybrid
  
protocol:
  primary: TEMPUS (spatial sampling of historical games)
  secondary: Conversational patterns (OMNI filter hierarchy)
```

### Example 2: Medical Diagnosis

```yaml
domain_info:
  has_irreversible_time: yes (disease progression)
  requires_continuous_experience: yes (patient follow-up)
  embodied_learning: yes (clinical examination skills)
  narrative_reinterpretation: yes (case reanalysis)
  pattern_based: yes (symptom patterns)

classification:
  primary: N
  secondary: C
  classification: N/C hybrid

protocol:
  primary: Fine-tuning on medical literature
  secondary: Conversational training on diagnostic workflows
```

### Example 3: Financial Trading

```yaml
domain_info:
  has_irreversible_time: yes (market events)
  spatial_navigation_possible: yes (historical data)
  random_access_data: yes (time-series database)
  pattern_based: yes (price patterns, indicators)

classification:
  primary: Cp
  secondary: N
  classification: Cp/N hybrid

protocol:
  primary: TEMPUS (spatial sampling of market history)
  secondary: Fine-tuning on financial fundamentals
```

---

## VALIDATION CHECKLIST

**Verify classification accuracy:**

```python
def validate_classification(domain_info, classification):
    """
    Sanity checks for classification
    """
    
    checks = []
    
    # Check 1: Cp requires spatial navigation
    if classification['primary_geometry'] == 'Cp':
        if not domain_info['spatial_navigation_possible']:
            checks.append({
                'check': 'Cp requires spatial navigation',
                'passed': False,
                'warning': 'Cp classification but spatial navigation not possible'
            })
        else:
            checks.append({'check': 'Cp spatial navigation', 'passed': True})
    
    # Check 2: N requires irreversibility
    if classification['primary_geometry'] == 'N':
        if not domain_info['has_irreversible_time']:
            checks.append({
                'check': 'N requires irreversible time',
                'passed': False,
                'warning': 'N classification but time not irreversible'
            })
        else:
            checks.append({'check': 'N irreversibility', 'passed': True})
    
    # Check 3: C requires narrative aspect
    if classification['primary_geometry'] == 'C':
        if not domain_info['narrative_reinterpretation']:
            checks.append({
                'check': 'C requires narrative reinterpretation',
                'passed': False,
                'warning': 'C classification but no narrative aspect'
            })
        else:
            checks.append({'check': 'C narrative aspect', 'passed': True})
    
    # Report
    all_passed = all(c['passed'] for c in checks)
    
    if not all_passed:
        print("\n⚠ VALIDATION WARNINGS:")
        for check in checks:
            if not check['passed']:
                print(f"  - {check['warning']}")
    
    return all_passed, checks
```

---

## ANTI-PATTERNS

❌ **Forcing Cp on N domains:** Sequential biology (aging) can't be spatially navigated
❌ **Ignoring hybrid nature:** Most real domains are multi-geometry
❌ **Over-simplifying:** "It's just Cp" when N/C components critical
❌ **Protocol mismatch:** Fine-tuning (N) for pattern-matching (Cp) problem
❌ **Ignoring cautions:** Each geometry has specific risks

---

## QUICK START

```python
# Complete classification workflow

# 1. Analyze domain
domain = analyze_domain()

# 2. Extract temporal signature
signature, signature_pct = extract_temporal_signature(domain)

# 3. Classify geometry
classification = classify_geometry(signature, signature_pct)

# 4. Recommend protocol
protocol = recommend_protocol(classification, domain)

# 5. Validate
valid, checks = validate_classification(domain, classification)

# 6. Generate report
report = generate_classification_report(domain, classification, protocol)

print(report)

# 7. Save
with open('temporal_classification.txt', 'w') as f:
    f.write(report)
```

---

**FIN SKILL**

Temporal geometry classifier - diagnostic for selecting appropriate formation protocol.
