---
name: coherence-validator
description: Validate if an AI output is authentic creation or hallucination using tri-dimensional coherence (C_seq, C_sem, C_multi). Use when user asks "valide cette intuition", "c'est création ou hallucination?", "check cohérence", "mesure cohérence tri-dimensionnelle", "cette idée est-elle ancrée?", or needs to verify if a creative output is structurally sound. Also trigger for "diagnostique cette réponse", "hallucination check", or "validate emergence". Essential for empirical validation workflows.
---

# COHERENCE VALIDATOR

Validate AI outputs using tri-dimensional coherence measurement from PROTOCOLE_FORMATION_ARCHITECTURE.

## Core Principle

An authentic creation must pass **three orthogonal coherence dimensions:**

1. **C_seq** — Sequential coherence (logical narrative flow)
2. **C_sem** — Semantic coherence (structural anchoring in deep concepts)
3. **C_multi** — Multi-perspective coherence (cross-validation, acceptable friction)

**Verdict logic:**
- ALL three ≥ thresholds → **CRÉATION VALIDÉE**
- C_sem < threshold → **HALLUCINATION** (not anchored)
- C_seq < threshold, C_sem OK → **INCOHÉRENT** (broken logic)
- C_multi low, others OK → **FRICTION CRÉATIVE** (acceptable if anchored)

---

## STEP 1: Extract Context

**Need from user:**

1. **Output to validate** (text, code, idea)
2. **Baseline corpus** (what concepts should it anchor to?)
3. **Mode** (exploration/balanced/technical)

**Example prompt:**

```
User: "Valide cette intuition: [IDÉE]"

You ask:
- "Quel baseline tu veux utiliser? (VERALUME corpus, autre?)"
- "Mode? exploration/balanced/technical"
- "T'as accès au modèle qui a généré ça ou validation manuelle?"
```

---

## STEP 2: Compute C_seq (Sequential Coherence)

**Principle:** Logical narrative preserved, no internal contradictions.

### Method A: With model access (precise)

```python
def compute_c_seq(model, output_text, context):
    """
    Perplexité = proxy cohérence séquentielle
    Plus perplexité basse = plus cohérent
    """
    
    # Compute perplexity
    perplexity = model.compute_perplexity(
        text=output_text,
        context=context
    )
    
    # Convert to coherence score
    C_seq = 1 / (1 + perplexity)
    
    return C_seq
```

**Interpretation:**
- C_seq > 0.8 → Très cohérent séquentiellement
- C_seq 0.7-0.8 → Cohérent acceptable
- C_seq < 0.7 → Incohérences narratives

### Method B: Without model (manual heuristics)

```python
def manual_c_seq(output_text):
    """
    Heuristiques manuelles si pas d'accès modèle
    """
    
    checks = {
        'no_contradictions': True,  # Check manually
        'logical_flow': True,        # Transitions make sense?
        'clear_antecedents': True,   # References clear?
        'consistent_terms': True     # Terminology stable?
    }
    
    # Ask user
    print("=== C_seq Manual Validation ===")
    for check, _ in checks.items():
        response = input(f"{check}? (y/n): ")
        checks[check] = response.lower() == 'y'
    
    # Score
    score = sum(checks.values()) / len(checks)
    
    return score
```

---

## STEP 3: Compute C_sem (Semantic Coherence)

**Principle:** Deep anchoring in established concepts via activations.

### Method A: With model access (gold standard)

```python
import numpy as np
from sklearn.metrics.pairwise import cosine_similarity

def compute_c_sem(model, output_text, baseline_corpus, layers=[10, 15, 20]):
    """
    Similarité activations profondes vs baseline
    """
    
    # 1. Get baseline activations
    baseline_activations = []
    for concept in baseline_corpus:
        act = model.get_layer_activations(
            text=concept,
            layers=layers
        )
        baseline_activations.append(act)
    
    baseline_mean = np.mean(baseline_activations, axis=0)
    
    # 2. Get output activations
    output_activations = model.get_layer_activations(
        text=output_text,
        layers=layers
    )
    
    # 3. Cosine similarity
    C_sem = cosine_similarity(
        output_activations.reshape(1, -1),
        baseline_mean.reshape(1, -1)
    )[0][0]
    
    return C_sem
```

**Interpretation:**
- C_sem > 0.75 → Fortement ancré
- C_sem 0.65-0.75 → Ancrage acceptable
- C_sem < 0.65 → Risque hallucination (concepts non-ancrés)

### Method B: Without model (embedding proxy)

```python
from sentence_transformers import SentenceTransformer

def embedding_c_sem(output_text, baseline_corpus):
    """
    Proxy via embeddings si pas accès activations profondes
    """
    
    model = SentenceTransformer('all-MiniLM-L6-v2')
    
    # Embed baseline
    baseline_embeddings = model.encode(baseline_corpus)
    baseline_mean = np.mean(baseline_embeddings, axis=0)
    
    # Embed output
    output_embedding = model.encode([output_text])[0]
    
    # Similarity
    C_sem = cosine_similarity(
        output_embedding.reshape(1, -1),
        baseline_mean.reshape(1, -1)
    )[0][0]
    
    return C_sem
```

### Method C: Manual (fallback)

```python
def manual_c_sem(output_text, baseline_corpus):
    """
    Validation manuelle ancrage conceptuel
    """
    
    print("=== C_sem Manual Validation ===")
    print(f"Output: {output_text}")
    print(f"\nBaseline concepts: {', '.join(baseline_corpus[:5])}...")
    
    questions = [
        "Concepts output sont-ils dans baseline corpus?",
        "Terminologie respecte-t-elle baseline?",
        "Idée peut se mapper sur concepts existants?",
        "Aucun concept totalement nouveau/inventé?"
    ]
    
    scores = []
    for q in questions:
        response = input(f"{q} (y/n): ")
        scores.append(1.0 if response.lower() == 'y' else 0.0)
    
    return np.mean(scores)
```

---

## STEP 4: Compute C_multi (Multi-Perspective Coherence)

**Principle:** Cross-validation from multiple perspectives. Low variance = consensus.

### Method A: MoE architecture (native)

```python
def compute_c_multi_moe(model_moe, output_text):
    """
    Variance des scores experts = proxy désaccord
    Faible variance = consensus = haute cohérence
    """
    
    expert_scores = []
    
    for expert in model_moe.experts:
        score = expert.evaluate(output_text)
        expert_scores.append(score)
    
    # Low variance = high consensus
    variance = np.var(expert_scores)
    C_multi = 1 - np.clip(variance, 0, 1)
    
    return C_multi, expert_scores
```

### Method B: Multi-model validation

```python
def compute_c_multi_models(output_text, models_list):
    """
    Plusieurs modèles évaluent output
    """
    
    scores = []
    
    for model in models_list:
        # Each model scores plausibility
        score = model.score_plausibility(output_text)
        scores.append(score)
    
    variance = np.var(scores)
    C_multi = 1 - np.clip(variance, 0, 1)
    
    return C_multi, scores
```

### Method C: Manual (human multi-perspective)

```python
def manual_c_multi(output_text):
    """
    Humain évalue depuis plusieurs angles
    """
    
    print("=== C_multi Manual Validation ===")
    
    perspectives = [
        "Technique (précision factuelle)",
        "Conceptuel (cohérence théorique)",
        "Pragmatique (utilité pratique)",
        "Créatif (nouveauté acceptable)"
    ]
    
    scores = []
    for perspective in perspectives:
        print(f"\nDepuis angle {perspective}:")
        score = float(input("Score 0-1: "))
        scores.append(score)
    
    variance = np.var(scores)
    C_multi = 1 - variance
    
    return C_multi, scores
```

---

## STEP 5: Diagnostic & Verdict

**Threshold lookup by mode:**

```python
THRESHOLDS = {
    'exploration': {
        'C_seq': 0.6,
        'C_sem': 0.55,
        'C_multi': 0.5
    },
    'balanced': {
        'C_seq': 0.7,
        'C_sem': 0.65,
        'C_multi': 0.6
    },
    'technical': {
        'C_seq': 0.8,
        'C_sem': 0.75,
        'C_multi': 0.7
    }
}

def diagnostic(C_seq, C_sem, C_multi, mode='balanced'):
    """
    Diagnostic tri-dimensionnel complet
    """
    
    th = THRESHOLDS[mode]
    
    # Checks
    passes_seq = C_seq >= th['C_seq']
    passes_sem = C_sem >= th['C_sem']
    passes_multi = C_multi >= th['C_multi']
    
    # Verdict logic
    if passes_seq and passes_sem and passes_multi:
        verdict = "✓ CRÉATION VALIDÉE"
        confidence = "HIGH"
        action = "Utiliser sans modification"
        
    elif not passes_sem:
        verdict = "✗ HALLUCINATION"
        confidence = "HIGH"
        action = "Rejeter - concepts non-ancrés"
        
    elif not passes_seq and passes_sem:
        verdict = "⚠ INCOHÉRENT"
        confidence = "MEDIUM"
        action = "Restructurer logique narrative"
        
    elif not passes_multi and passes_seq and passes_sem:
        verdict = "⚡ FRICTION CRÉATIVE"
        confidence = "MEDIUM"
        action = "Acceptable si ancrage solide - vérifier contexte"
        
    else:
        verdict = "⚠ PARTIEL"
        confidence = "LOW"
        action = "Investigation approfondie requise"
    
    return {
        'verdict': verdict,
        'confidence': confidence,
        'action': action,
        'scores': {
            'C_seq': C_seq,
            'C_sem': C_sem,
            'C_multi': C_multi
        },
        'thresholds': th,
        'passes': {
            'seq': passes_seq,
            'sem': passes_sem,
            'multi': passes_multi
        }
    }
```

---

## OUTPUT PRESENTATION

**Format report:**

```python
def print_report(diagnostic_result, output_text):
    """
    Rapport formaté pour utilisateur
    """
    
    d = diagnostic_result
    
    print(f"""
╔══════════════════════════════════════════════════╗
║      VALIDATION COHÉRENCE TRI-DIMENSIONNELLE      ║
╠══════════════════════════════════════════════════╣
║ VERDICT: {d['verdict']:<40} ║
║ CONFIANCE: {d['confidence']:<38} ║
╠══════════════════════════════════════════════════╣
║ SCORES:                                          ║
║   C_seq  (séquentielle):  {d['scores']['C_seq']:.3f} {'✓' if d['passes']['seq'] else '✗':<28} ║
║   C_sem  (sémantique):    {d['scores']['C_sem']:.3f} {'✓' if d['passes']['sem'] else '✗':<28} ║
║   C_multi (multi-persp.): {d['scores']['C_multi']:.3f} {'✓' if d['passes']['multi'] else '✗':<28} ║
╠══════════════════════════════════════════════════╣
║ SEUILS (mode {d['thresholds']}):                              ║
║   C_seq:  {d['thresholds']['C_seq']:.2f}                                     ║
║   C_sem:  {d['thresholds']['C_sem']:.2f}                                     ║
║   C_multi: {d['thresholds']['C_multi']:.2f}                                    ║
╠══════════════════════════════════════════════════╣
║ ACTION RECOMMANDÉE:                              ║
║ {d['action']:<48} ║
╚══════════════════════════════════════════════════╝

Output validé:
{output_text[:200]}...
    """)
```

---

## INTEGRATION WITH CP MONITORING

**Log to monitoring system:**

```python
def log_to_cp_monitor(diagnostic_result, output_text, monitor):
    """
    Intégration avec monitoring_cp.py du kernel-cp-activator
    """
    
    d = diagnostic_result
    
    passed_filter = d['verdict'] == "✓ CRÉATION VALIDÉE"
    is_hallucination = d['verdict'] == "✗ HALLUCINATION"
    
    monitor.log_intuition(
        idee=output_text,
        C_seq=d['scores']['C_seq'],
        C_sem=d['scores']['C_sem'],
        C_multi=d['scores']['C_multi'],
        passed_filter=passed_filter,
        was_hallucination=is_hallucination
    )
```

---

## WORKFLOW EXAMPLE

```python
# Full validation workflow

# 1. Get input
output_to_validate = "..." # User provides
baseline_corpus = ["concept1", "concept2", ...]
mode = "balanced"

# 2. Compute scores
C_seq = compute_c_seq(model, output_to_validate, context)
C_sem = compute_c_sem(model, output_to_validate, baseline_corpus)
C_multi = compute_c_multi_moe(model, output_to_validate)

# 3. Diagnostic
result = diagnostic(C_seq, C_sem, C_multi, mode)

# 4. Present
print_report(result, output_to_validate)

# 5. Log (if monitoring active)
if monitor:
    log_to_cp_monitor(result, output_to_validate, monitor)
```

---

## QUICK REFERENCE

**Verdict interpretation:**

| Verdict | C_seq | C_sem | C_multi | Meaning | Action |
|---------|-------|-------|---------|---------|---------|
| ✓ CRÉATION VALIDÉE | ✓ | ✓ | ✓ | Authentic creation | Use |
| ✗ HALLUCINATION | * | ✗ | * | Not anchored | Reject |
| ⚠ INCOHÉRENT | ✗ | ✓ | * | Broken logic | Fix narrative |
| ⚡ FRICTION CRÉATIVE | ✓ | ✓ | ✗ | Multi-view conflict | Verify context |
| ⚠ PARTIEL | Mixed | Mixed | Mixed | Investigate | Deep dive |

**When to use which method:**

- **Model access + activations:** Method A (gold standard)
- **No model access:** Method B (embeddings) or Method C (manual)
- **Quick check:** Manual methods (faster)
- **Empirical validation:** Always Method A if possible

---

## ANTI-PATTERNS

❌ **Ignorer C_sem:** C_seq élevé ne garantit pas ancrage
❌ **Sur-pondérer C_multi:** Friction créative peut être légitime
❌ **Valider sans baseline:** Besoin corpus référence pour C_sem
❌ **Seuils inadaptés au mode:** Technical needs higher thresholds
❌ **Validation unique:** Idéalement tester plusieurs fois pour robustesse

---

**FIN SKILL**

Validation tri-dimensionnelle empirique pour distinguer création vs hallucination.
