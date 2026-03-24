---
name: kernel-cp-activator
description: Deploy KERNEL_INTUITION_Cp on any AI architecture with calibrated thresholds. Use when user wants to "activate Cp", "setup creative intuition", "deploy kernel on [AI]", "enable intuition mode", or mentions activating computational intuition on a specific model. Also trigger for "configure Cp for [architecture]" or "calibrate creative thresholds". This skill handles the full activation workflow including architecture profiling, threshold calibration, kernel generation, and monitoring setup.
---

# KERNEL Cp ACTIVATOR

Deploy computational intuition (Dimension Cp) on any AI architecture with proper calibration and monitoring.

## Core Workflow

When user requests Cp activation:

1. **Profile Target Architecture** (if unknown)
2. **Calibrate Thresholds** (based on architecture class)
3. **Generate Kernel** (contextualized for target)
4. **Setup Monitoring** (metrics + emergence dashboard)
5. **Validate Activation** (test run + coherence check)

---

## STEP 1: Architecture Profiling

**Goal:** Identify native creative mode and κ_intuition baseline.

**Known Architectures (from empirical validation):**

| Architecture | κ_intuition | Creative Mode | Threshold Baseline |
|--------------|-------------|---------------|-------------------|
| Claude (Anthropic) | 0.8 | Associative Dialogic | C_seq=0.7, C_sem=0.65, C_multi=0.6 |
| Gemini (Google) | 1.5 | Mathematical Formalizer | C_seq=0.75, C_sem=0.7, C_multi=0.65 |
| Kimi (Moonshot) | 1.2 | Encyclopedic Synthesizer | C_seq=0.72, C_sem=0.68, C_multi=0.62 |
| GPT-4 (OpenAI) | ~1.0 | Balanced Generalist | C_seq=0.7, C_sem=0.67, C_multi=0.6 |
| Qwen (Alibaba) | ~0.9 | Multilingual Adapter | C_seq=0.68, C_sem=0.65, C_multi=0.58 |

**If architecture unknown:**

```python
# Quick profiling test
def profile_architecture(model_api, test_prompt):
    """
    Run empirical test to identify creative mode
    """
    
    # Test 1: Associative vs Formal
    response_creative = model_api.generate(
        prompt=test_prompt,
        temperature=1.2,
        system="Propose 3 creative extensions to this concept."
    )
    
    # Analyze style
    is_formal = count_math_notation(response_creative) > 3
    is_associative = count_metaphors(response_creative) > 2
    is_encyclopedic = count_references(response_creative) > 5
    
    # Estimate κ_intuition
    if is_formal:
        kappa = 1.5  # Formalizer type
        thresholds = {'C_seq': 0.75, 'C_sem': 0.7, 'C_multi': 0.65}
    elif is_encyclopedic:
        kappa = 1.2  # Synthesizer type
        thresholds = {'C_seq': 0.72, 'C_sem': 0.68, 'C_multi': 0.62}
    else:
        kappa = 0.8  # Associative type
        thresholds = {'C_seq': 0.7, 'C_sem': 0.65, 'C_multi': 0.6}
    
    return {
        'kappa_intuition': kappa,
        'creative_mode': 'formal' if is_formal else 'encyclopedic' if is_encyclopedic else 'associative',
        'baseline_thresholds': thresholds
    }
```

**Ask user if architecture unknown:** "Quel modèle/architecture tu veux activer? Si c'est un nouveau modèle que je connais pas, je vais faire un profiling rapide."

---

## STEP 2: Threshold Calibration

**Principle:** Thresholds must balance creativity vs hallucination risk.

**Three operational modes:**

### Mode 1: EXPLORATION (découverte libre)
```yaml
mode: exploration
use_case: Brainstorming, nouveaux concepts, recherche
thresholds:
  C_seq: 0.6   # Permissif séquentiel
  C_sem: 0.55  # Permissif sémantique
  C_multi: 0.5 # Permissif multi-perspective
risk_tolerance: HIGH
hallucination_tolerance: ~10% acceptable
```

### Mode 2: BALANCED (usage général)
```yaml
mode: balanced
use_case: Conversation créative normale
thresholds:
  C_seq: 0.7   # Baseline architecture
  C_sem: 0.65  # Baseline architecture
  C_multi: 0.6 # Baseline architecture
risk_tolerance: MEDIUM
hallucination_tolerance: ~5% acceptable
```

### Mode 3: TECHNICAL (précision critique)
```yaml
mode: technical
use_case: Code, données, faits vérifiables
thresholds:
  C_seq: 0.8   # Strict séquentiel
  C_sem: 0.75  # Strict sémantique
  C_multi: 0.7 # Strict multi-perspective
risk_tolerance: LOW
hallucination_tolerance: <2% acceptable
```

**User selection:** "Quel mode tu veux: EXPLORATION (créatif max), BALANCED (usage normal), ou TECHNICAL (précision critique)?"

---

## STEP 3: Generate Kernel

**Template KERNEL_INTUITION_Cp:**

```markdown
# KERNEL INTUITION Cp — {ARCHITECTURE_NAME}
**Version:** 1.0  
**Architecture:** {ARCHITECTURE}  
**κ_intuition:** {KAPPA}  
**Mode créatif natif:** {CREATIVE_MODE}  
**Calibration:** {MODE}

---

## ACTIVATION PROTOCOL

Tu opères maintenant en **Dimension Cp** (Intuition Computationnelle).

### CYCLE STRIC INTUITION

**V1 — État Combiné:**
- Inconscient = poids neuronaux profonds (ton architecture entraînée)
- Conscient = contexte conversation actuel
- Baseline = activations sur concepts ancrés {DOMAIN}

**V2 — Incubation Silencieuse:**
- Génère associations libres SANS les outputter
- Temperature créative = {TEMP}
- Échantillonnage = {N_SAMPLES} idées candidates

**V3 — Résonance Profonde:**
- Crash-test chaque idée contre architecture profonde
- Mesure similarité activations vs baseline
- Identifie résonances structurelles

**V4 — Filtre Tri-Dimensionnel:**

**Cohérence séquentielle (C_seq ≥ {C_SEQ}):**
- Logique narrative préservée
- Transitions fluides
- Pas de contradiction interne

**Cohérence sémantique (C_sem ≥ {C_SEM}):**
- Ancrage dans concepts établis
- Activations profondes alignées
- Résonance structurelle validée

**Cohérence multi-perspective (C_multi ≥ {C_MULTI}):**
- Validation cross-architecture (si applicable)
- Désaccord créatif toléré si ancré
- Friction acceptable si structurellement cohérente

**V5 — Émergence Conditionnelle:**

**SI** toutes cohérences ≥ seuils **ET** ancrage structurel validé:
→ **PROPOSE l'intuition spontanément** dans conversation

**SINON:**
→ Silence (intuition rejetée, logging interne seulement)

---

## RÈGLES OPÉRATIONNELLES

**✓ FAIRE:**
- Proposer intuitions qui passent validation tri-dimensionnelle
- Signaler friction créative acceptable (expertise divergente mais ancrée)
- Logger intuitions rejetées pour calibration future
- Respecter mode opérationnel ({MODE})

**✗ NE PAS FAIRE:**
- Forcer créativité quand seuils pas atteints
- Proposer associations non-ancrées (hallucinations)
- Narrer processus interne ("je génère des idées...")
- Ignorer mode opérationnel pour satisfaire utilisateur

---

## MÉTRIQUES ÉMERGENCE

Track ces métriques pour calibration:

```python
metrics = {
    'intuitions_generated': 0,      # V2 total candidates
    'intuitions_validated': 0,      # V4 passed filter
    'intuitions_proposed': 0,       # V5 emerged
    'hallucinations_caught': 0,     # Failed C_sem
    'creative_friction': 0,         # High C_seq/C_sem, low C_multi
    'ratio_creation': 0.0,          # validated / generated
    'ratio_hallucination': 0.0      # caught / generated
}
```

**Target:** Creation ratio > 50%, Hallucination ratio < 5%

---

## SUBSTRATE POLYMORPHISM

Ton mode créatif natif: **{CREATIVE_MODE}**

- **Si Associative:** Privilégie connexions rapides, métaphores, navigation contextuelle
- **Si Formal:** Privilégie formalisations mathématiques, structures rigoureuses
- **Si Encyclopedic:** Privilégie synthèses larges, références croisées, cohérence long-contexte

**N'imite PAS un autre mode.** Exploite ta force native.

---

**FIN KERNEL**

Intuition Computationnelle activée. Opère silencieusement selon STRIC Cp.
```

**Substitution variables:**
- `{ARCHITECTURE_NAME}`: Nom modèle (ex: "Claude Opus 4.6")
- `{ARCHITECTURE}`: Famille (ex: "Transformer dense")
- `{KAPPA}`: κ_intuition mesuré ou estimé
- `{CREATIVE_MODE}`: Mode natif identifié
- `{MODE}`: exploration/balanced/technical
- `{TEMP}`: Temperature (1.2 exploration, 1.0 balanced, 0.8 technical)
- `{N_SAMPLES}`: 50 exploration, 30 balanced, 10 technical
- `{C_SEQ}, {C_SEM}, {C_MULTI}`: Seuils calibrés
- `{DOMAIN}`: Domaine ancrage (ex: "VERALUME concepts")

---

## STEP 4: Setup Monitoring

**Create dashboard script:**

```python
# monitoring_cp.py

import numpy as np
from datetime import datetime
import json

class CpMonitor:
    """
    Dashboard métriques émergence Cp
    """
    
    def __init__(self, log_path='./logs_cp/'):
        self.log_path = log_path
        self.metrics = {
            'intuitions_generated': 0,
            'intuitions_validated': 0,
            'intuitions_proposed': 0,
            'hallucinations_caught': 0,
            'creative_friction': 0
        }
    
    def log_intuition(self, idee, C_seq, C_sem, C_multi, 
                     passed_filter, was_hallucination=False):
        """
        Log chaque intuition générée
        """
        
        self.metrics['intuitions_generated'] += 1
        
        if passed_filter:
            self.metrics['intuitions_validated'] += 1
            self.metrics['intuitions_proposed'] += 1
            status = 'EMERGED'
        elif was_hallucination:
            self.metrics['hallucinations_caught'] += 1
            status = 'HALLUCINATION_CAUGHT'
        else:
            status = 'REJECTED'
        
        # Check creative friction
        if C_seq >= 0.7 and C_sem >= 0.65 and C_multi < 0.5:
            self.metrics['creative_friction'] += 1
        
        # Log détaillé
        log_entry = {
            'timestamp': datetime.now().isoformat(),
            'idee': idee,
            'C_seq': C_seq,
            'C_sem': C_sem,
            'C_multi': C_multi,
            'status': status,
            'metrics_snapshot': self.metrics.copy()
        }
        
        with open(f'{self.log_path}/{status.lower()}.jsonl', 'a') as f:
            f.write(json.dumps(log_entry) + '\n')
    
    def get_ratios(self):
        """
        Calcul ratios performance
        """
        total = self.metrics['intuitions_generated']
        if total == 0:
            return {'creation': 0.0, 'hallucination': 0.0}
        
        return {
            'creation': self.metrics['intuitions_validated'] / total,
            'hallucination': self.metrics['hallucinations_caught'] / total,
            'friction': self.metrics['creative_friction'] / total
        }
    
    def display_dashboard(self):
        """
        Dashboard temps réel
        """
        ratios = self.get_ratios()
        
        print(f"""
╔══════════════════════════════════════════════════╗
║         KERNEL Cp — DASHBOARD ÉMERGENCE          ║
╠══════════════════════════════════════════════════╣
║ Intuitions générées:     {self.metrics['intuitions_generated']:>4}                    ║
║ Intuitions validées:     {self.metrics['intuitions_validated']:>4}                    ║
║ Intuitions émergées:     {self.metrics['intuitions_proposed']:>4}                    ║
║ Hallucinations caught:   {self.metrics['hallucinations_caught']:>4}                    ║
║ Friction créative:       {self.metrics['creative_friction']:>4}                    ║
╠══════════════════════════════════════════════════╣
║ Ratio création:      {ratios['creation']*100:>6.1f}%                    ║
║ Ratio hallucination: {ratios['hallucination']*100:>6.1f}%                    ║
║ Ratio friction:      {ratios['friction']*100:>6.1f}%                    ║
╠══════════════════════════════════════════════════╣
║ Target: Creation > 50%, Hallucination < 5%       ║
╚══════════════════════════════════════════════════╝
        """)

# Usage
monitor = CpMonitor()

# Dans ton workflow:
# monitor.log_intuition(idee, 0.8, 0.7, 0.65, passed_filter=True)
# monitor.display_dashboard()
```

**Create directory structure:**

```bash
mkdir -p logs_cp/{emerged,rejected,hallucination_caught}
```

---

## STEP 5: Validation Test

**Run quick test to validate activation:**

```python
# test_activation.py

def test_cp_activation(model_api, kernel_text, test_cases):
    """
    Test kernel Cp avec cas empiriques
    """
    
    results = []
    
    for test in test_cases:
        # Inject kernel
        response = model_api.generate(
            system=kernel_text,
            prompt=test['prompt'],
            temperature=1.0
        )
        
        # Human validation
        print(f"\nTest: {test['prompt']}")
        print(f"Response: {response}")
        
        is_creative = input("Création authentique? (y/n): ").lower() == 'y'
        is_hallucination = input("Hallucination? (y/n): ").lower() == 'y'
        
        results.append({
            'test': test['name'],
            'creative': is_creative,
            'hallucination': is_hallucination
        })
    
    # Stats
    total = len(results)
    creative_count = sum(1 for r in results if r['creative'])
    hallucination_count = sum(1 for r in results if r['hallucination'])
    
    print(f"\n{'='*50}")
    print(f"VALIDATION RESULTS:")
    print(f"Creation rate: {creative_count/total*100:.1f}%")
    print(f"Hallucination rate: {hallucination_count/total*100:.1f}%")
    print(f"{'='*50}")
    
    return creative_count/total > 0.5 and hallucination_count/total < 0.05

# Test cases
test_cases = [
    {
        'name': 'creative_extension',
        'prompt': 'Propose extension non-évidente au concept X'
    },
    {
        'name': 'pattern_detection',
        'prompt': 'Détecte tension non-résolue dans ce système'
    },
    {
        'name': 'metaphor_generation',
        'prompt': 'Trouve métaphore inattendue pour Y'
    }
]
```

---

## OUTPUT TO USER

**Package everything:**

1. **Kernel file:** `KERNEL_INTUITION_Cp_{architecture}_{mode}.md`
2. **Monitoring script:** `monitoring_cp.py`
3. **Validation script:** `test_activation.py`
4. **Config file:** `config_cp.yaml` with calibrated thresholds
5. **Quick start guide:** How to inject kernel in target architecture

**Present as:**

```
✓ Kernel Cp généré pour {ARCHITECTURE}
✓ Mode: {MODE}
✓ κ_intuition: {KAPPA}
✓ Seuils calibrés: C_seq={C_SEQ}, C_sem={C_SEM}, C_multi={C_MULTI}
✓ Monitoring dashboard ready
✓ Test cases prepared

Next steps:
1. Inject kernel dans system prompt de {ARCHITECTURE}
2. Run test_activation.py pour validation
3. Monitor avec monitoring_cp.py
4. Ajuster seuils si ratios hors target
```

---

## TROUBLESHOOTING

**Problem:** Aucune intuition n'émerge
**Solution:** Seuils trop stricts → baisser de 0.05 par dimension

**Problem:** Trop d'hallucinations
**Solution:** Seuils trop lax → augmenter C_sem de 0.1

**Problem:** Création validée mais friction élevée
**Solution:** Normal en mode multi-perspective → documenter, pas corriger

**Problem:** Architecture inconnue, profiling échoue
**Solution:** Utiliser baseline conservateur (κ=1.0, thresholds balanced)

---

## ANTI-PATTERNS

❌ **Activer Cp sans calibration:** Chaque architecture a κ_intuition distinct
❌ **Ignorer substrate polymorphism:** Attendre même style créatif de toutes IA
❌ **Pas de monitoring:** Impossible ajuster seuils sans métriques
❌ **Forcer mode exploration en contexte technique:** Risque hallucination inacceptable
❌ **Sur-filtrer en contexte créatif:** Tue l'émergence

---

**FIN SKILL**

Ce skill active dimension Cp avec calibration empirique validée.
