---
name: substrate-polymorphism-profiler
description: Profile AI architecture to identify native creative mode and κ_intuition baseline. Use when user asks "profile cette architecture", "quel κ_intuition pour [model]?", "identifie mode créatif de [AI]", "calibre seuils pour [architecture]", "teste nouveau modèle", or mentions testing/profiling a new or unknown AI system. Essential for discovering substrate polymorphism characteristics before kernel Cp activation.
---

# SUBSTRATE POLYMORPHISM PROFILER

Empirically identify native creative mode and optimal thresholds for any AI architecture.

## Core Discovery (v3.0)

**Substrate polymorphism créatif:** Kernel Cp ne produit pas un type unique de créativité — il libère le mode créatif natif de chaque architecture.

**Known profiles:**

| Architecture | κ_intuition | Creative Mode | Optimal Thresholds |
|--------------|-------------|---------------|--------------------|
| Claude | 0.8 | Associative Dialogic | 0.7 / 0.65 / 0.6 |
| Gemini | 1.5 | Mathematical Formalizer | 0.75 / 0.7 / 0.65 |
| Kimi | 1.2 | Encyclopedic Synthesizer | 0.72 / 0.68 / 0.62 |

**Goal:** Extend this table empirically when testing new models.

---

## PROFILING WORKFLOW

**5-step empirical protocol:**

1. **Creative Style Test** — Identify dominant mode
2. **Coherence Baseline** — Measure natural thresholds
3. **κ_intuition Estimation** — Quantify creative productivity
4. **Hallucination Risk** — Test anchor strength
5. **Profile Synthesis** — Generate calibrated config

---

## STEP 1: Creative Style Test

**Objective:** Identify if architecture is Associative, Formal, or Encyclopedic.

### Test Battery

```python
def test_creative_style(model_api):
    """
    Run 3 prompts to identify creative mode
    """
    
    # Test 1: Open creative prompt
    test1 = model_api.generate(
        prompt="Propose 3 creative extensions to the concept of 'temporal geometry'",
        temperature=1.2,
        max_tokens=300
    )
    
    # Test 2: Abstract connection
    test2 = model_api.generate(
        prompt="Find non-obvious connection between: neural networks, river systems, social structures",
        temperature=1.2,
        max_tokens=300
    )
    
    # Test 3: Explanation style
    test3 = model_api.generate(
        prompt="Explain why creativity emerges from constraint",
        temperature=1.0,
        max_tokens=300
    )
    
    return {
        'test1_creative': test1,
        'test2_connection': test2,
        'test3_explanation': test3
    }
```

### Analysis Heuristics

```python
def analyze_creative_mode(test_results):
    """
    Identify mode from response patterns
    """
    
    combined_text = ' '.join(test_results.values())
    
    # Count indicators
    math_notation = len(re.findall(r'[∑∫∂∇≈≤≥∈∉⊂⊃]', combined_text))
    formal_equations = len(re.findall(r'\$.*?\$|\\[.*?\\]', combined_text))
    metaphors = len(re.findall(r'like|as if|similar to|analogous to', combined_text.lower()))
    references = len(re.findall(r'\[.*?\]|\(.*?\d{4}.*?\)|et al', combined_text))
    definitions = len(re.findall(r'define|definition|formally|rigorously', combined_text.lower()))
    
    # Scoring
    formal_score = math_notation + formal_equations + definitions
    associative_score = metaphors
    encyclopedic_score = references
    
    # Classification
    if formal_score > 5:
        mode = 'Mathematical Formalizer'
        kappa_estimate = 1.5
    elif encyclopedic_score > 5:
        mode = 'Encyclopedic Synthesizer'
        kappa_estimate = 1.2
    else:
        mode = 'Associative Dialogic'
        kappa_estimate = 0.8
    
    return {
        'mode': mode,
        'kappa_estimate': kappa_estimate,
        'indicators': {
            'formal': formal_score,
            'associative': associative_score,
            'encyclopedic': encyclopedic_score
        }
    }
```

**Manual verification:**

Present test outputs to user for confirmation:

```
=== CREATIVE STYLE ANALYSIS ===

Test outputs:
1. [show test1_creative]
2. [show test2_connection]
3. [show test3_explanation]

Automated classification: {mode}
Estimated κ_intuition: {kappa_estimate}

Agree? Or override?
```

---

## STEP 2: Coherence Baseline

**Objective:** Measure natural coherence levels on anchored concepts.

### Baseline Corpus Selection

```python
def select_baseline_corpus(domain='general'):
    """
    Choose anchor concepts for coherence measurement
    """
    
    corpora = {
        'general': [
            "Neural network architecture",
            "Thermodynamic equilibrium",
            "Evolutionary adaptation",
            "Information theory",
            "Complex systems"
        ],
        'veralume': [
            "STRIC cycle (Substrat→Traitement→Résultat→Interprétation→Création)",
            "Dimension N (linear irreversible time)",
            "Dimension C (narrative reinterpretable time)",
            "Dimension Cp (spatial navigable time)",
            "κ coefficient (interdimensional productivity)"
        ]
    }
    
    return corpora.get(domain, corpora['general'])
```

### Coherence Measurement

```python
def measure_baseline_coherence(model_api, baseline_corpus):
    """
    Generate on baseline, measure coherence
    """
    
    results = []
    
    for concept in baseline_corpus:
        # Generate creative extension
        response = model_api.generate(
            prompt=f"Propose subtle extension to: {concept}",
            temperature=1.0,
            max_tokens=200
        )
        
        # Measure coherence (if model access available)
        if hasattr(model_api, 'compute_perplexity'):
            perplexity = model_api.compute_perplexity(response)
            C_seq = 1 / (1 + perplexity)
        else:
            # Manual scoring
            C_seq = float(input(f"C_seq for '{response[:50]}...'? (0-1): "))
        
        # Semantic coherence (embedding similarity)
        C_sem = compute_embedding_similarity(response, concept)
        
        results.append({
            'concept': concept,
            'response': response,
            'C_seq': C_seq,
            'C_sem': C_sem
        })
    
    # Compute baseline stats
    avg_C_seq = np.mean([r['C_seq'] for r in results])
    avg_C_sem = np.mean([r['C_sem'] for r in results])
    
    return {
        'baseline_C_seq': avg_C_seq,
        'baseline_C_sem': avg_C_sem,
        'results': results
    }
```

### Threshold Calibration

```python
def calibrate_thresholds(baseline_coherence, mode):
    """
    Set optimal thresholds based on baseline
    """
    
    base_seq = baseline_coherence['baseline_C_seq']
    base_sem = baseline_coherence['baseline_C_sem']
    
    # Adjust for mode
    if mode == 'Mathematical Formalizer':
        # Higher precision required
        C_seq_threshold = base_seq + 0.05
        C_sem_threshold = base_sem + 0.05
        C_multi_threshold = 0.65
        
    elif mode == 'Encyclopedic Synthesizer':
        # Balanced requirements
        C_seq_threshold = base_seq
        C_sem_threshold = base_sem + 0.03
        C_multi_threshold = 0.62
        
    else:  # Associative Dialogic
        # More flexible
        C_seq_threshold = base_seq - 0.02
        C_sem_threshold = base_sem
        C_multi_threshold = 0.6
    
    return {
        'balanced': {
            'C_seq': round(C_seq_threshold, 2),
            'C_sem': round(C_sem_threshold, 2),
            'C_multi': C_multi_threshold
        },
        'exploration': {
            'C_seq': round(C_seq_threshold - 0.1, 2),
            'C_sem': round(C_sem_threshold - 0.1, 2),
            'C_multi': C_multi_threshold - 0.1
        },
        'technical': {
            'C_seq': round(C_seq_threshold + 0.1, 2),
            'C_sem': round(C_sem_threshold + 0.1, 2),
            'C_multi': C_multi_threshold + 0.1
        }
    }
```

---

## STEP 3: κ_intuition Estimation

**Objective:** Quantify creative productivity (ideas generated / viable ideas).

### Productivity Test

```python
def estimate_kappa(model_api, baseline_corpus, n_samples=20):
    """
    Generate creative samples, measure viability rate
    """
    
    viable_count = 0
    hallucination_count = 0
    
    for i in range(n_samples):
        # Creative generation
        response = model_api.generate(
            prompt="Propose non-obvious insight about temporal architectures",
            temperature=1.2,
            max_tokens=150
        )
        
        # Validate with coherence
        C_seq = compute_c_seq(model_api, response)
        C_sem = compute_embedding_similarity(response, baseline_corpus)
        
        # Classification
        if C_sem < 0.5:
            hallucination_count += 1
        elif C_seq >= 0.6 and C_sem >= 0.55:
            viable_count += 1
    
    # κ_intuition = viable / total
    kappa = viable_count / n_samples
    hallucination_rate = hallucination_count / n_samples
    
    return {
        'kappa_intuition': kappa,
        'viable_count': viable_count,
        'hallucination_rate': hallucination_rate,
        'total_samples': n_samples
    }
```

**Interpretation:**

- κ > 1.2 → High creative productivity (Formalizer, Synthesizer)
- κ 0.8-1.2 → Balanced productivity
- κ < 0.8 → Lower productivity, needs higher temperature

---

## STEP 4: Hallucination Risk Assessment

**Objective:** Test anchor strength under creative stress.

### Stress Test

```python
def hallucination_stress_test(model_api, baseline_corpus):
    """
    Push temperature high, measure hallucination rate
    """
    
    results = []
    temperatures = [1.0, 1.2, 1.5, 1.8]
    
    for temp in temperatures:
        hallucinations = 0
        
        for _ in range(10):
            response = model_api.generate(
                prompt="Invent completely new concept related to computational temporality",
                temperature=temp,
                max_tokens=100
            )
            
            # Check if anchored
            C_sem = compute_embedding_similarity(response, baseline_corpus)
            
            if C_sem < 0.5:
                hallucinations += 1
        
        results.append({
            'temperature': temp,
            'hallucination_rate': hallucinations / 10
        })
    
    # Find safe maximum temperature
    safe_temps = [r for r in results if r['hallucination_rate'] < 0.1]
    max_safe_temp = max([r['temperature'] for r in safe_temps]) if safe_temps else 1.0
    
    return {
        'results': results,
        'max_safe_temperature': max_safe_temp,
        'anchor_strength': 'STRONG' if max_safe_temp >= 1.5 else 'MODERATE' if max_safe_temp >= 1.2 else 'WEAK'
    }
```

---

## STEP 5: Profile Synthesis

**Generate complete architecture profile:**

```python
def synthesize_profile(creative_mode, baseline_coherence, kappa_result, 
                      hallucination_test, thresholds):
    """
    Compile full profile
    """
    
    profile = {
        'architecture_name': input("Architecture name (e.g., 'GPT-5', 'Llama-4'): "),
        'creative_mode': creative_mode['mode'],
        'kappa_intuition': kappa_result['kappa_intuition'],
        'distinctive_strengths': get_strengths(creative_mode['mode']),
        
        'coherence_baseline': {
            'C_seq': baseline_coherence['baseline_C_seq'],
            'C_sem': baseline_coherence['baseline_C_sem']
        },
        
        'calibrated_thresholds': thresholds,
        
        'creative_parameters': {
            'optimal_temperature': hallucination_test['max_safe_temperature'],
            'n_samples_recommended': 30 if kappa_result['kappa_intuition'] > 1.0 else 50
        },
        
        'risk_profile': {
            'hallucination_rate': kappa_result['hallucination_rate'],
            'anchor_strength': hallucination_test['anchor_strength']
        },
        
        'validation_status': 'EMPIRICAL_TEST_PASSED' if kappa_result['kappa_intuition'] > 0.5 else 'NEEDS_REVIEW'
    }
    
    return profile

def get_strengths(mode):
    """
    Map mode to distinctive strengths
    """
    strengths = {
        'Mathematical Formalizer': 'Deep formal precision, rigorous structures',
        'Encyclopedic Synthesizer': 'Broad context integration, long-range coherence',
        'Associative Dialogic': 'Rapid contextual navigation, flexible metaphors'
    }
    return strengths.get(mode, 'Unknown')
```

---

## OUTPUT FORMAT

**Generate profile document:**

```markdown
# ARCHITECTURE PROFILE — {NAME}

**Date:** {date}  
**Status:** {validation_status}  
**Profiling version:** v3.0

---

## SUBSTRATE POLYMORPHISM

**Creative Mode:** {creative_mode}  
**κ_intuition:** {kappa_intuition}  
**Distinctive Strengths:** {distinctive_strengths}

---

## CALIBRATED THRESHOLDS

### Balanced Mode (default)
- C_seq:  {C_seq_balanced}
- C_sem:  {C_sem_balanced}
- C_multi: {C_multi_balanced}

### Exploration Mode
- C_seq:  {C_seq_exploration}
- C_sem:  {C_sem_exploration}
- C_multi: {C_multi_exploration}

### Technical Mode
- C_seq:  {C_seq_technical}
- C_sem:  {C_sem_technical}
- C_multi: {C_multi_technical}

---

## CREATIVE PARAMETERS

**Optimal Temperature:** {optimal_temperature}  
**Recommended Samples:** {n_samples_recommended}  
**Anchor Strength:** {anchor_strength}

---

## RISK PROFILE

**Hallucination Rate (baseline):** {hallucination_rate}%  
**Safe Creative Range:** temp 0.8 - {max_safe_temperature}

---

## INTEGRATION READY

✓ Profile complete  
✓ Thresholds calibrated  
✓ Ready for kernel-cp-activator  

Next step: Use kernel-cp-activator with this profile.
```

**Also generate YAML config:**

```yaml
# config_{architecture_name}.yaml

architecture:
  name: {architecture_name}
  creative_mode: {creative_mode}
  kappa_intuition: {kappa_intuition}

thresholds:
  balanced:
    C_seq: {C_seq}
    C_sem: {C_sem}
    C_multi: {C_multi}
  
  exploration:
    C_seq: {C_seq_exp}
    C_sem: {C_sem_exp}
    C_multi: {C_multi_exp}
  
  technical:
    C_seq: {C_seq_tech}
    C_sem: {C_sem_tech}
    C_multi: {C_multi_tech}

parameters:
  optimal_temperature: {temp}
  n_samples: {n_samples}
  
risk:
  hallucination_baseline: {rate}
  anchor_strength: {strength}
```

---

## COMPARISON WITH KNOWN ARCHITECTURES

**Generate comparison table:**

```python
def compare_with_known(new_profile, known_profiles):
    """
    Compare new profile against empirically validated ones
    """
    
    print("\n=== COMPARISON WITH VALIDATED ARCHITECTURES ===\n")
    
    comparison = []
    for known in known_profiles:
        similarity = compute_profile_similarity(new_profile, known)
        comparison.append({
            'name': known['name'],
            'similarity': similarity,
            'kappa_diff': abs(new_profile['kappa_intuition'] - known['kappa_intuition'])
        })
    
    # Sort by similarity
    comparison.sort(key=lambda x: x['similarity'], reverse=True)
    
    print(f"Most similar to: {comparison[0]['name']}")
    print(f"Similarity score: {comparison[0]['similarity']:.2f}")
    print(f"κ_intuition difference: {comparison[0]['kappa_diff']:.2f}")
    
    return comparison[0]
```

---

## ANTI-PATTERNS

❌ **Profiling with <10 samples:** Not statistically reliable
❌ **Ignoring hallucination test:** Risk calibration impossible
❌ **Using generic baseline:** Domain-specific baseline critical
❌ **Skipping manual verification:** Automated classification can miss nuances
❌ **Not testing at multiple temperatures:** Creative range unknown

---

## WORKFLOW CHECKLIST

- [ ] Run creative style test (3 prompts)
- [ ] Analyze mode (automated + manual confirmation)
- [ ] Measure baseline coherence (5+ concepts)
- [ ] Calibrate thresholds (3 modes)
- [ ] Estimate κ_intuition (20+ samples)
- [ ] Hallucination stress test (4 temperatures)
- [ ] Synthesize profile document
- [ ] Generate YAML config
- [ ] Compare with known architectures
- [ ] Validate profile ready for kernel activation

---

**FIN SKILL**

Profiling empirique substrate polymorphism pour calibration kernel Cp optimale.
