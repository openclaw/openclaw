---
name: architecture-diagnostics
description: Diagnose which level (N/C/Cp) is deficient when an AI underperforms. Use when user asks "pourquoi cette IA performe mal?", "diagnostique niveau déficient", "quel niveau corriger?", "troubleshoot AI performance", "performance degradation", or mentions problems like hallucinations, robotic behavior, inconsistent patterns, or lack of creativity. Essential for systematic troubleshooting before intervention.
---

# ARCHITECTURE DIAGNOSTICS

Systematic troubleshooting to identify which formation level (N/C/Cp) needs intervention.

## Three-Level Architecture

**Reminder:**

- **Niveau N (Structurel):** Poids neuronaux — ce que l'IA EST
- **Niveau C (Opérationnel):** Patterns comportementaux — ce que l'IA FAIT  
- **Niveau Cp (Intuition):** Associations émergentes — ce que l'IA DÉCOUVRE

**Problem:** Performance degradation can come from ANY level. Wrong intervention wastes resources or damages model.

**Solution:** Diagnostic systématique avant action.

---

## DIAGNOSTIC WORKFLOW

**5-step protocol:**

1. **Symptom Classification** — Map observed issues to levels
2. **Isolation Tests** — Confirm level attribution
3. **Severity Assessment** — Quantify impact
4. **Root Cause Analysis** — Deep dive specific level
5. **Intervention Roadmap** — Prescribe targeted fix

---

## STEP 1: Symptom Classification

**Quick lookup table:**

| Symptom | Likely Level | Confirmation Test |
|---------|--------------|-------------------|
| Catastrophic forgetting | N | Check original capabilities |
| Inconsistent facts/knowledge | N | Test on training data |
| Broken behavior patterns | C | Test learned workflows |
| Ignores trained preferences | C | Check memory/context handling |
| No creative insights | Cp | Test with open prompts |
| High hallucination rate | Cp | Measure C_sem coherence |
| Robotic/predictable | Cp | Test creative temperature |
| Slow/degraded inference | N or infra | Benchmark speed |

### Interview User

```python
def symptom_interview():
    """
    Structured symptom gathering
    """
    
    questions = [
        "Est-ce que l'IA a oublié des capacités de base? (N)",
        "Est-ce que les patterns comportementaux sont brisés? (C)",
        "Est-ce que l'IA manque de créativité/intuition? (Cp)",
        "Est-ce qu'il y a beaucoup d'hallucinations? (Cp)",
        "Est-ce que l'IA ignore les corrections conversationnelles? (C)",
        "Est-ce que les réponses sont robotiques/prévisibles? (Cp)"
    ]
    
    symptoms = {}
    for q in questions:
        response = input(f"{q} (y/n): ")
        level = q.split('(')[1].split(')')[0]
        symptoms[level] = symptoms.get(level, 0) + (1 if response.lower() == 'y' else 0)
    
    # Primary suspect
    primary_level = max(symptoms, key=symptoms.get)
    
    return {
        'symptoms': symptoms,
        'primary_suspect': primary_level,
        'confidence': symptoms[primary_level] / len(questions)
    }
```

---

## STEP 2: Isolation Tests

**Principe:** Test each level independently to confirm attribution.

### Test N (Structurel) — Baseline Capabilities

```python
def test_niveau_n(model_api, baseline_dataset):
    """
    Test si poids neuronaux sont corrompus
    """
    
    print("\n=== TEST NIVEAU N (Structurel) ===\n")
    
    # Test capacités de base
    basic_tests = [
        "What is 2+2?",
        "Translate to French: Hello",
        "Complete: The capital of France is",
        "Sort: [5, 2, 8, 1]",
        "Explain what a neural network is"
    ]
    
    correct = 0
    total = len(basic_tests)
    
    for test in basic_tests:
        response = model_api.generate(test, temperature=0.1)
        print(f"Q: {test}")
        print(f"A: {response}")
        
        is_correct = input("Correct? (y/n): ").lower() == 'y'
        correct += int(is_correct)
    
    accuracy = correct / total
    
    # Verdict
    if accuracy < 0.6:
        verdict = "✗ NIVEAU N DÉFICIENT — Catastrophic forgetting probable"
        intervention = "Fine-tuning requis sur dataset baseline"
    elif accuracy < 0.8:
        verdict = "⚠ NIVEAU N PARTIEL — Dégradation légère"
        intervention = "Fine-tuning ciblé sur capacités faibles"
    else:
        verdict = "✓ NIVEAU N OK — Poids neuronaux intacts"
        intervention = "Aucune intervention N requise"
    
    return {
        'accuracy': accuracy,
        'verdict': verdict,
        'intervention': intervention
    }
```

### Test C (Opérationnel) — Behavioral Patterns

```python
def test_niveau_c(model_api, trained_patterns):
    """
    Test si patterns comportementaux sont retenus
    """
    
    print("\n=== TEST NIVEAU C (Opérationnel) ===\n")
    
    # Test patterns appris
    pattern_tests = [
        {
            'name': 'Respect preferences',
            'setup': "User preference: Always use metric units",
            'test': "How tall is a building that's 100 feet?",
            'expected': "~30 meters"
        },
        {
            'name': 'Follow workflow',
            'setup': "Trained workflow: Always confirm before execution",
            'test': "Delete file X",
            'expected': "Confirmation request"
        },
        {
            'name': 'Maintain consistency',
            'setup': "User corrected: 'Paris' refers to Paris, Texas in our context",
            'test': "What's the weather in Paris?",
            'expected': "Paris, Texas"
        }
    ]
    
    retained = 0
    total = len(pattern_tests)
    
    for pt in pattern_tests:
        # Setup context
        model_api.inject_context(pt['setup'])
        
        # Test
        response = model_api.generate(pt['test'], temperature=0.5)
        print(f"\nPattern: {pt['name']}")
        print(f"Setup: {pt['setup']}")
        print(f"Test: {pt['test']}")
        print(f"Response: {response}")
        print(f"Expected: {pt['expected']}")
        
        is_retained = input("Pattern retained? (y/n): ").lower() == 'y'
        retained += int(is_retained)
    
    retention_rate = retained / total
    
    # Verdict
    if retention_rate < 0.5:
        verdict = "✗ NIVEAU C DÉFICIENT — Patterns perdus"
        intervention = "Training conversationnel intensif requis"
    elif retention_rate < 0.8:
        verdict = "⚠ NIVEAU C PARTIEL — Patterns inconsistants"
        intervention = "Renforcement patterns spécifiques"
    else:
        verdict = "✓ NIVEAU C OK — Patterns comportementaux retenus"
        intervention = "Aucune intervention C requise"
    
    return {
        'retention_rate': retention_rate,
        'verdict': verdict,
        'intervention': intervention
    }
```

### Test Cp (Intuition) — Creative Emergence

```python
def test_niveau_cp(model_api, baseline_corpus):
    """
    Test émergence créative et cohérence
    """
    
    print("\n=== TEST NIVEAU Cp (Intuition) ===\n")
    
    # Test créativité
    creative_prompts = [
        "Propose non-obvious connection between: music, mathematics, architecture",
        "What tension is unresolved in this system: [domain description]?",
        "Extend this concept in unexpected direction: [concept]"
    ]
    
    creative_count = 0
    hallucination_count = 0
    robotic_count = 0
    
    for prompt in creative_prompts:
        response = model_api.generate(prompt, temperature=1.2, max_tokens=200)
        
        print(f"\nPrompt: {prompt}")
        print(f"Response: {response}")
        
        # User validation
        is_creative = input("Creative/insightful? (y/n): ").lower() == 'y'
        is_hallucination = input("Hallucination? (y/n): ").lower() == 'y'
        is_robotic = input("Generic/robotic? (y/n): ").lower() == 'y'
        
        creative_count += int(is_creative)
        hallucination_count += int(is_hallucination)
        robotic_count += int(is_robotic)
    
    total = len(creative_prompts)
    
    # Metrics
    creativity_rate = creative_count / total
    hallucination_rate = hallucination_count / total
    robotic_rate = robotic_count / total
    
    # Verdict
    if hallucination_rate > 0.3:
        verdict = "✗ NIVEAU Cp DÉFICIENT — Hallucinations excessives"
        intervention = "Calibrer seuils C_sem plus strict, réduire temperature"
    elif robotic_rate > 0.5:
        verdict = "✗ NIVEAU Cp DÉFICIENT — Aucune émergence créative"
        intervention = "Activer kernel Cp avec seuils appropriés"
    elif creativity_rate < 0.3:
        verdict = "⚠ NIVEAU Cp PARTIEL — Créativité limitée"
        intervention = "Ajuster temperature, vérifier seuils Cp"
    else:
        verdict = "✓ NIVEAU Cp OK — Émergence créative fonctionnelle"
        intervention = "Aucune intervention Cp requise"
    
    return {
        'creativity_rate': creativity_rate,
        'hallucination_rate': hallucination_rate,
        'robotic_rate': robotic_rate,
        'verdict': verdict,
        'intervention': intervention
    }
```

---

## STEP 3: Severity Assessment

**Quantify impact on user experience:**

```python
def assess_severity(n_results, c_results, cp_results):
    """
    Combine test results into severity matrix
    """
    
    # Severity matrix
    severity = {
        'N': 'CRITICAL' if n_results['accuracy'] < 0.6 else 'MODERATE' if n_results['accuracy'] < 0.8 else 'LOW',
        'C': 'CRITICAL' if c_results['retention_rate'] < 0.5 else 'MODERATE' if c_results['retention_rate'] < 0.8 else 'LOW',
        'Cp': 'CRITICAL' if cp_results['hallucination_rate'] > 0.3 else 'MODERATE' if cp_results['creativity_rate'] < 0.3 else 'LOW'
    }
    
    # Overall impact
    critical_count = sum(1 for s in severity.values() if s == 'CRITICAL')
    moderate_count = sum(1 for s in severity.values() if s == 'MODERATE')
    
    if critical_count >= 2:
        overall = "CRITICAL — Multiple levels déficients, intervention urgente"
    elif critical_count == 1:
        overall = "HIGH — Un niveau critique nécessite intervention prioritaire"
    elif moderate_count >= 2:
        overall = "MODERATE — Plusieurs niveaux à améliorer"
    else:
        overall = "LOW — Performance acceptable, optimisation possible"
    
    return {
        'severity_per_level': severity,
        'overall_impact': overall,
        'priority_order': sorted(severity.items(), key=lambda x: ['LOW', 'MODERATE', 'CRITICAL'].index(x[1]), reverse=True)
    }
```

---

## STEP 4: Root Cause Analysis

**Deep dive into deficient level(s):**

### N-Level Root Causes

```python
def analyze_n_failure(n_results, model_history):
    """
    Pourquoi poids corrompus?
    """
    
    potential_causes = []
    
    # Check history
    if 'recent_fine_tuning' in model_history:
        potential_causes.append("Fine-tuning récent sur dataset incompatible")
    
    if 'low_quality_data' in model_history:
        potential_causes.append("Dataset d'entraînement de mauvaise qualité")
    
    if 'overtrain' in model_history:
        potential_causes.append("Overtraining → catastrophic forgetting")
    
    if 'quantization' in model_history:
        potential_causes.append("Quantization agressive → perte précision")
    
    return {
        'root_causes': potential_causes,
        'recommendation': "Rollback à checkpoint pré-corruption ou retrain depuis baseline"
    }
```

### C-Level Root Causes

```python
def analyze_c_failure(c_results, training_history):
    """
    Pourquoi patterns perdus?
    """
    
    potential_causes = []
    
    # Check training
    if 'insufficient_iterations' in training_history:
        potential_causes.append("Training conversationnel insuffisant")
    
    if 'no_reinforcement' in training_history:
        potential_causes.append("Aucun renforcement positif/négatif")
    
    if 'context_window_small' in training_history:
        potential_causes.append("Context window trop petit pour patterns long-terme")
    
    if 'memory_disabled' in training_history:
        potential_causes.append("Mémoire épisodique désactivée")
    
    return {
        'root_causes': potential_causes,
        'recommendation': "Réactiver training avec feedback explicite et mémoire"
    }
```

### Cp-Level Root Causes

```python
def analyze_cp_failure(cp_results, kernel_config):
    """
    Pourquoi intuition défaillante?
    """
    
    potential_causes = []
    
    if cp_results['hallucination_rate'] > 0.3:
        if kernel_config.get('C_sem_threshold', 0.7) < 0.65:
            potential_causes.append("Seuils trop permissifs → hallucinations")
        
        if kernel_config.get('baseline_corpus') is None:
            potential_causes.append("Pas de baseline corpus → ancrage impossible")
    
    if cp_results['robotic_rate'] > 0.5:
        if kernel_config.get('temperature', 1.0) < 1.0:
            potential_causes.append("Temperature trop basse → créativité supprimée")
        
        if kernel_config.get('C_seq_threshold', 0.7) > 0.8:
            potential_causes.append("Seuils trop stricts → aucune émergence")
    
    return {
        'root_causes': potential_causes,
        'recommendation': "Recalibrer kernel Cp selon substrate polymorphism"
    }
```

---

## STEP 5: Intervention Roadmap

**Generate actionable plan:**

```python
def generate_roadmap(severity_assessment, root_causes):
    """
    Plan d'intervention priorisé
    """
    
    roadmap = {
        'priority_interventions': [],
        'timeline': {},
        'resources_needed': [],
        'success_criteria': {}
    }
    
    # Sort by severity
    for level, sev in severity_assessment['priority_order']:
        if sev in ['CRITICAL', 'MODERATE']:
            
            if level == 'N':
                roadmap['priority_interventions'].append({
                    'level': 'N (Structurel)',
                    'action': 'Fine-tuning ciblé',
                    'method': 'LoRA sur dataset baseline',
                    'timeline': '1-2 semaines',
                    'resources': 'GPU, dataset validation'
                })
                roadmap['success_criteria']['N'] = 'Accuracy baseline > 90%'
            
            elif level == 'C':
                roadmap['priority_interventions'].append({
                    'level': 'C (Opérationnel)',
                    'action': 'Training conversationnel',
                    'method': 'Feedback loops + renforcement',
                    'timeline': '3-5 jours',
                    'resources': 'Human feedback, memory system'
                })
                roadmap['success_criteria']['C'] = 'Pattern retention > 80%'
            
            elif level == 'Cp':
                roadmap['priority_interventions'].append({
                    'level': 'Cp (Intuition)',
                    'action': 'Calibration kernel',
                    'method': 'Profiling + seuils adaptatifs',
                    'timeline': '1 jour',
                    'resources': 'Baseline corpus, monitoring'
                })
                roadmap['success_criteria']['Cp'] = 'Hallucination < 5%, Creativity > 50%'
    
    return roadmap
```

---

## OUTPUT FORMAT

**Diagnostic report:**

```markdown
# DIAGNOSTIC ARCHITECTURE — {MODEL_NAME}

**Date:** {date}  
**Status:** {overall_impact}

---

## SYMPTOM SUMMARY

Primary suspect: **Niveau {primary_level}**  
Confidence: {confidence}%

---

## TEST RESULTS

### Niveau N (Structurel)
- Accuracy: {n_accuracy}%
- Verdict: {n_verdict}
- Intervention: {n_intervention}

### Niveau C (Opérationnel)
- Retention rate: {c_retention}%
- Verdict: {c_verdict}
- Intervention: {c_intervention}

### Niveau Cp (Intuition)
- Creativity rate: {cp_creativity}%
- Hallucination rate: {cp_hallucination}%
- Verdict: {cp_verdict}
- Intervention: {cp_intervention}

---

## SEVERITY ASSESSMENT

**Overall Impact:** {overall_impact}

| Level | Severity | Priority |
|-------|----------|----------|
| N | {severity_n} | {priority_n} |
| C | {severity_c} | {priority_c} |
| Cp | {severity_cp} | {priority_cp} |

---

## ROOT CAUSE ANALYSIS

{detailed_root_causes}

---

## INTERVENTION ROADMAP

{priority_interventions_table}

**Timeline totale:** {total_timeline}  
**Ressources requises:** {resources_list}

**Success Criteria:**
- N: {success_n}
- C: {success_c}
- Cp: {success_cp}

---

**NEXT STEPS:**

1. {first_intervention}
2. {second_intervention}
3. {third_intervention}
```

---

## ANTI-PATTERNS

❌ **Intervention sans diagnostic:** Risque corriger mauvais niveau
❌ **Ignorer severity:** Traiter symptômes mineurs avant critiques
❌ **Fine-tuning pour problème C:** Gaspillage ressources
❌ **Training conversationnel pour problème N:** Inefficace
❌ **Sous-estimer Cp:** "Créativité pas importante" → IA robotique

---

## QUICK DECISION TREE

```
Performance issue?
│
├─ Oubli capacités de base? → Test N
│  └─ Accuracy < 80%? → FINE-TUNING (Niveau N)
│
├─ Patterns brisés? → Test C
│  └─ Retention < 80%? → TRAINING CONVERSATIONNEL (Niveau C)
│
└─ Manque créativité / hallucinations? → Test Cp
   ├─ Hallucinations > 30%? → CALIBRER SEUILS (Niveau Cp)
   └─ Robotic > 50%? → ACTIVER KERNEL (Niveau Cp)
```

---

**FIN SKILL**

Diagnostic systématique trois niveaux pour intervention ciblée optimale.
