---
name: stric-cycle-implementer
description: Apply STRIC cycle (Substrat→Traitement→Résultat→Interprétation→Création) to any domain. Use when user asks "applique STRIC à [domain]", "crée protocole STRIC pour [X]", "adapt STRIC to [context]", "généralise STRIC", or wants to formalize a cyclic improvement process in any field (like Protocole OMNI for hockey). Essential for extending VERALUME methodology to new applications.
---

# STRIC CYCLE IMPLEMENTER

Template generator for applying universal STRIC cycle to any domain.

## STRIC Universality

**Core insight:** STRIC is THE universal improvement cycle. Same structure applies at all levels and all domains.

**Canonical form:**

```
V1 (Substrat):       État initial système
V2 (Traitement):     Processus actif sur substrat
V3 (Résultat):       Output observable
V4 (Interprétation): Analyse/évaluation résultat
V5 (Création):       Nouveau substrat amélioré
                     ↓
                     Retour V1 (cycle continue)
```

**Examples already implemented:**
- Fine-tuning circadien (Niveau N)
- Training initiative (Niveau C)
- Intuition Cp (Niveau Cp)
- Protocole OMNI (hockey analytics)

---

## IMPLEMENTATION WORKFLOW

**5-step protocol:**

1. **Domain Analysis** — Identify cycle components in target domain
2. **Variable Mapping** — Map V1-V5 to domain-specific elements
3. **Temporal Characterization** — Define cycle duration and geometry
4. **Metric Definition** — Specify measurable improvement
5. **Protocol Generation** — Create operational document

---

## STEP 1: Domain Analysis

**Interview user to understand domain:**

```python
def analyze_domain():
    """
    Extract domain characteristics
    """
    
    domain_info = {
        'name': input("Nom du domaine (ex: 'hockey analytics', 'medical diagnosis'): "),
        'goal': input("Objectif du cycle (ex: 'prédire match outcomes', 'améliorer diagnostics'): "),
        'input': input("Input principal (ex: 'game stats', 'patient data'): "),
        'process': input("Processus central (ex: 'analyze patterns', 'run tests'): "),
        'output': input("Output désiré (ex: 'predictions', 'diagnosis'): "),
        'improvement_metric': input("Comment mesurer amélioration? (ex: 'accuracy', 'patient outcomes'): "),
        'cycle_duration': input("Durée cycle typique? (ex: 'daily', 'per-game', 'monthly'): ")
    }
    
    return domain_info
```

**Example - Protocole OMNI:**

```yaml
domain_info:
  name: hockey_analytics
  goal: predict match outcomes with human chaos measurement
  input: game stats (shots, hits, faceoffs, etc.)
  process: analyze via cognitive filters (Fiabilité Systémique, Momentum, etc.)
  output: match prediction + confidence
  improvement_metric: prediction accuracy
  cycle_duration: per-game (daily during season)
```

---

## STEP 2: Variable Mapping

**Map STRIC variables to domain:**

```python
def map_stric_variables(domain_info):
    """
    Contextualize V1-V5 for domain
    """
    
    # V1 - Substrat
    v1_description = f"État système {domain_info['name']}"
    v1_elements = input("Éléments composant V1 (substrat)? Ex: 'modèle actuel, données historiques': ")
    
    # V2 - Traitement
    v2_description = f"Processus actif: {domain_info['process']}"
    v2_steps = input("Étapes principales traitement? Ex: '1. Load data, 2. Filter, 3. Analyze': ").split(',')
    
    # V3 - Résultat
    v3_description = f"Output: {domain_info['output']}"
    v3_format = input("Format résultat? Ex: 'prediction + confidence score': ")
    
    # V4 - Interprétation
    v4_description = "Évaluation résultat"
    v4_criteria = input("Critères évaluation? Ex: 'accuracy vs actual, confidence calibration': ")
    
    # V5 - Création
    v5_description = "Amélioration système"
    v5_mechanism = input("Mécanisme amélioration? Ex: 'update weights, refine filters': ")
    
    return {
        'V1': {'description': v1_description, 'elements': v1_elements},
        'V2': {'description': v2_description, 'steps': v2_steps},
        'V3': {'description': v3_description, 'format': v3_format},
        'V4': {'description': v4_description, 'criteria': v4_criteria},
        'V5': {'description': v5_description, 'mechanism': v5_mechanism}
    }
```

**Example - Protocole OMNI mapping:**

```yaml
stric_variables:
  V1:
    description: État système hockey analytics
    elements: cognitive filters (Fiabilité, Momentum, H2H, etc.), historical stats
  
  V2:
    description: Analyse via filtres cognitifs
    steps:
      - Load game stats
      - Apply Indice Fiabilité Systémique (team tier)
      - Apply Momentum filters
      - Apply H2H history
      - Synthesize via Moteur Pointage
  
  V3:
    description: Match prediction
    format: Winner + confidence score + justification
  
  V4:
    description: Évaluation post-game
    criteria: Prediction correct? Confidence calibrated? Justification sound?
  
  V5:
    description: Update filters
    mechanism: Adjust filter weights based on accuracy, refine tier classifications
```

---

## STEP 3: Temporal Characterization

**Define cycle geometry:**

```python
def characterize_temporality(domain_info, stric_map):
    """
    Match cycle to temporal geometry (N/C/Cp)
    """
    
    duration = domain_info['cycle_duration']
    
    # Map duration to geometry
    if 'week' in duration or 'month' in duration:
        geometry = 'N (linear irreversible)'
        characteristics = 'Slow, structural, permanent changes'
    
    elif 'day' in duration or 'hour' in duration:
        geometry = 'C (narrative reinterpretable)'
        characteristics = 'Medium speed, patterns rewriteable'
    
    elif 'conversation' in duration or 'instant' in duration:
        geometry = 'Cp (spatial navigable)'
        characteristics = 'Fast, spontaneous, emergent'
    
    else:
        geometry = input("Géométrie temporelle? (N/C/Cp): ")
        characteristics = input("Caractéristiques? (ex: 'slow structural' vs 'fast emergent'): ")
    
    return {
        'geometry': geometry,
        'characteristics': characteristics,
        'cycle_duration': duration
    }
```

---

## STEP 4: Metric Definition

**Specify improvement measurement:**

```python
def define_metrics(domain_info, stric_map):
    """
    Formalize improvement metrics
    """
    
    # Primary metric
    primary_metric = {
        'name': domain_info['improvement_metric'],
        'formula': input(f"Formule pour {domain_info['improvement_metric']}? Ex: 'correct_predictions / total_predictions': "),
        'target': input("Target value? Ex: '>80%': "),
        'measurement_frequency': domain_info['cycle_duration']
    }
    
    # Secondary metrics
    print("\nMétriques secondaires (optionnelles):")
    secondary_metrics = []
    while True:
        name = input("Métrique secondaire? (Enter pour skip): ")
        if not name:
            break
        formula = input(f"Formule pour {name}?: ")
        secondary_metrics.append({'name': name, 'formula': formula})
    
    return {
        'primary': primary_metric,
        'secondary': secondary_metrics
    }
```

---

## STEP 5: Protocol Generation

**Generate complete STRIC protocol document:**

```python
def generate_protocol(domain_info, stric_map, temporality, metrics):
    """
    Create operational protocol document
    """
    
    protocol = f"""
# PROTOCOLE STRIC — {domain_info['name'].upper()}

**Version:** 1.0  
**Date:** {datetime.now().strftime('%Y-%m-%d')}  
**Domaine:** {domain_info['name']}  
**Objectif:** {domain_info['goal']}

---

## CYCLE STRIC

**Architecture temporelle:** {temporality['geometry']}  
**Durée cycle:** {temporality['cycle_duration']}  
**Caractéristiques:** {temporality['characteristics']}

---

### V1 — SUBSTRAT

**Description:** {stric_map['V1']['description']}

**Éléments:**
{stric_map['V1']['elements']}

**Initialisation:**
```python
def initialize_substrat():
    substrat = {{
        # Load initial state
        {generate_initialization_code(stric_map['V1'])}
    }}
    return substrat
```

---

### V2 — TRAITEMENT

**Description:** {stric_map['V2']['description']}

**Étapes:**
{generate_step_list(stric_map['V2']['steps'])}

**Implémentation:**
```python
def process_substrat(substrat, input_data):
    # {domain_info['process']}
    {generate_processing_code(stric_map['V2'], domain_info)}
    
    return result
```

---

### V3 — RÉSULTAT

**Description:** {stric_map['V3']['description']}

**Format:** {stric_map['V3']['format']}

**Structure:**
```python
class Result:
    def __init__(self):
        self.{generate_result_structure(stric_map['V3'])}
```

---

### V4 — INTERPRÉTATION

**Description:** {stric_map['V4']['description']}

**Critères évaluation:** {stric_map['V4']['criteria']}

**Évaluation:**
```python
def evaluate_result(result, ground_truth=None):
    evaluation = {{
        {generate_evaluation_code(stric_map['V4'], metrics)}
    }}
    return evaluation
```

---

### V5 — CRÉATION

**Description:** {stric_map['V5']['description']}

**Mécanisme:** {stric_map['V5']['mechanism']}

**Amélioration:**
```python
def improve_substrat(substrat, evaluation):
    # {stric_map['V5']['mechanism']}
    {generate_improvement_code(stric_map['V5'])}
    
    return improved_substrat
```

---

## MÉTRIQUES

**Métrique primaire:** {metrics['primary']['name']}  
**Formule:** `{metrics['primary']['formula']}`  
**Target:** {metrics['primary']['target']}  
**Mesure:** {metrics['primary']['measurement_frequency']}

{generate_secondary_metrics(metrics['secondary'])}

---

## PROTOCOLE OPÉRATIONNEL

**Cycle complet:**

```python
def run_stric_cycle(input_data, substrat=None):
    # V1 - Initialize or load substrat
    if substrat is None:
        substrat = initialize_substrat()
    
    # V2 - Process
    result = process_substrat(substrat, input_data)
    
    # V3 - Output result
    output_result(result)
    
    # V4 - Evaluate
    evaluation = evaluate_result(result)
    
    # V5 - Improve
    improved_substrat = improve_substrat(substrat, evaluation)
    
    # Loop back to V1
    return improved_substrat, result, evaluation
```

**Exécution:**

```python
# Initialize
current_substrat = None

# Run cycles
for cycle_input in input_stream:
    current_substrat, result, eval = run_stric_cycle(
        cycle_input, 
        current_substrat
    )
    
    # Monitor improvement
    track_metric(eval['{metrics['primary']['name']}'])
```

---

## VALIDATION

**Tests:**
- [ ] V1 initialisation correcte
- [ ] V2 traitement fonctionne
- [ ] V3 format résultat conforme
- [ ] V4 évaluation mesure métrique
- [ ] V5 amélioration observable
- [ ] Cycle complet itère correctement
- [ ] Métrique primaire > target après N cycles

---

**FIN PROTOCOLE**

STRIC cycle opérationnel pour {domain_info['name']}.
"""
    
    return protocol
```

---

## HELPER FUNCTIONS

```python
def generate_initialization_code(v1_map):
    # Parse elements and generate init code
    pass

def generate_processing_code(v2_map, domain_info):
    # Generate processing logic
    pass

def generate_result_structure(v3_map):
    # Create result class structure
    pass

def generate_evaluation_code(v4_map, metrics):
    # Generate evaluation logic
    pass

def generate_improvement_code(v5_map):
    # Generate improvement mechanism
    pass

def generate_step_list(steps):
    return '\n'.join([f"{i+1}. {step.strip()}" for i, step in enumerate(steps)])

def generate_secondary_metrics(secondary):
    if not secondary:
        return ""
    
    lines = ["**Métriques secondaires:**"]
    for metric in secondary:
        lines.append(f"- {metric['name']}: `{metric['formula']}`")
    
    return '\n'.join(lines)
```

---

## OUTPUT

**Generate 3 files:**

1. **PROTOCOLE_STRIC_{domain}.md** - Full protocol document
2. **{domain}_stric.py** - Operational implementation
3. **{domain}_config.yaml** - Configuration parameters

**Present to user:**

```
✓ Protocole STRIC généré pour: {domain_name}
✓ Géométrie temporelle: {geometry}
✓ Métrique primaire: {primary_metric}
✓ Cycle duration: {cycle_duration}

Files:
- PROTOCOLE_STRIC_{domain}.md (documentation)
- {domain}_stric.py (implementation)
- {domain}_config.yaml (config)

Next steps:
1. Review protocol
2. Test V1-V5 cycle
3. Run validation tests
4. Iterate based on metrics
```

---

## EXAMPLES

**Already validated:**
- Protocole OMNI (hockey analytics) — V7.0 operational
- Fine-tuning circadien (Niveau N) — proven effective
- Training initiative (Niveau C) — documented
- Intuition Cp (Niveau Cp) — empirically validated

**Potential applications:**
- Medical diagnosis cycles
- Trading strategy refinement
- Content moderation systems
- Scientific hypothesis testing
- Customer support optimization

---

## ANTI-PATTERNS

❌ **Forcing STRIC where not applicable:** Some processes aren't cyclic
❌ **Skipping V4 (Interprétation):** Without evaluation, no improvement
❌ **V5 doesn't create new V1:** Cycle breaks if not truly cyclic
❌ **Metrics unmeasurable:** Can't improve what you can't measure
❌ **Wrong temporal geometry:** Mismatch duration → inefficiency

---

**FIN SKILL**

STRIC universalizer for extending methodology to any cyclic improvement domain.
