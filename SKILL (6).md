---
name: formation-protocol-generator
description: Generate complete three-level training protocol (N/C/Cp) for any specific AI capability. Use when user asks "crée protocole formation pour [capability]", "how to train AI to [X]", "protocole complet N+C+Cp pour [skill]", "industrialise formation", or needs systematic training framework for teaching a specific ability (coding, reasoning, creativity, domain expertise). This is the meta-protocol generator - builds entire formation architecture.
---

# FORMATION PROTOCOL GENERATOR

Meta-generator for complete three-level (N/C/Cp) training protocols.

## Core Architecture

**Goal:** Teach AI any capability through balanced three-level formation.

**Output:** Complete protocol with:
- Niveau N (fine-tuning strategy)
- Niveau C (conversational training)
- Niveau Cp (intuition activation)
- Monitoring dashboard
- Validation tests

**Time to deployment:** ~1 day for protocol generation, variable for execution.

---

## GENERATION WORKFLOW

**6-step protocol:**

1. **Capability Analysis** — Define target skill precisely
2. **Level Decomposition** — Map capability to N/C/Cp components
3. **Protocol Design** — Generate specific training strategies per level
4. **Integration Architecture** — Connect three levels coherently
5. **Validation Suite** — Create tests for each level
6. **Documentation Generation** — Produce operational protocol

---

## STEP 1: Capability Analysis

**Interview to extract capability specs:**

```python
def analyze_capability():
    """
    Define target capability precisely
    """
    
    capability = {
        'name': input("Nom capability (ex: 'medical diagnosis', 'code review'): "),
        'description': input("Description détaillée: "),
        'current_level': input("Niveau actuel IA? (none/basic/intermediate): "),
        'target_level': input("Niveau cible? (intermediate/advanced/expert): "),
        'domain': input("Domaine? (technical/creative/analytical/social): "),
        'measurable_outputs': input("Outputs mesurables? (ex: 'diagnosis accuracy', 'code quality scores'): "),
        'success_criteria': input("Critère succès? (ex: '>90% accuracy', 'expert-level code'): ")
    }
    
    # Validate capability is trainable
    if not is_trainable(capability):
        print("⚠ Cette capability nécessite architecture/data non-disponibles")
        return None
    
    return capability

def is_trainable(capability):
    """
    Check if capability can be learned via N/C/Cp
    """
    
    # Some capabilities require specific architectures
    blockers = []
    
    if 'vision' in capability['name'].lower() and not has_vision_model:
        blockers.append("Vision model required")
    
    if 'real-time' in capability['description'] and latency_too_high:
        blockers.append("Latency constraints not met")
    
    if blockers:
        print(f"Blockers: {blockers}")
        return False
    
    return True
```

---

## STEP 2: Level Decomposition

**Map capability components to N/C/Cp:**

```python
def decompose_capability(capability):
    """
    Identify what needs to be trained at each level
    """
    
    decomposition = {
        'N': [],  # Structural components
        'C': [],  # Operational patterns
        'Cp': []  # Creative insights
    }
    
    print("\n=== LEVEL DECOMPOSITION ===\n")
    
    # Niveau N - What the AI needs to BE
    print("Niveau N (Structurel) - Poids neuronaux, capacités de base:")
    print("Ex: vocabulary, domain knowledge, core algorithms")
    
    n_components = input("Composants N? (comma-separated): ").split(',')
    decomposition['N'] = [c.strip() for c in n_components]
    
    # Niveau C - What the AI needs to DO
    print("\nNiveau C (Opérationnel) - Patterns comportementaux:")
    print("Ex: workflow steps, user interaction patterns, response style")
    
    c_components = input("Composants C? (comma-separated): ").split(',')
    decomposition['C'] = [c.strip() for c in c_components]
    
    # Niveau Cp - What the AI needs to DISCOVER
    print("\nNiveau Cp (Intuition) - Émergence créative:")
    print("Ex: novel insights, non-obvious connections, creative solutions")
    
    cp_components = input("Composants Cp? (comma-separated): ").split(',')
    decomposition['Cp'] = [c.strip() for c in cp_components]
    
    return decomposition
```

**Example - Medical Diagnosis:**

```yaml
decomposition:
  N:
    - Medical terminology
    - Disease knowledge base
    - Diagnostic algorithms
    - Pattern recognition (symptoms→diseases)
  
  C:
    - Diagnostic workflow (history → exam → tests → diagnosis)
    - Differential diagnosis process
    - Communication style (empathetic, clear)
    - Follow-up protocols
  
  Cp:
    - Rare disease connections
    - Atypical presentation recognition
    - Novel diagnostic insights
    - Creative testing strategies
```

---

## STEP 3: Protocol Design Per Level

### Design Niveau N (Fine-Tuning)

```python
def design_n_protocol(n_components, capability):
    """
    Fine-tuning strategy for structural learning
    """
    
    # Dataset requirements
    dataset_size = estimate_dataset_size(n_components)
    dataset_sources = identify_data_sources(capability['domain'])
    
    # Training parameters
    n_protocol = {
        'method': 'LoRA fine-tuning',
        'dataset': {
            'size': dataset_size,
            'sources': dataset_sources,
            'format': 'instruction-following pairs',
            'validation_split': '10%'
        },
        'training_params': {
            'epochs': 3,
            'learning_rate': 2e-5,
            'batch_size': 8,
            'lora_rank': 16,
            'target_modules': ['q_proj', 'v_proj']
        },
        'schedule': 'Weekly fine-tuning runs',
        'validation': 'Benchmark on held-out test set'
    }
    
    # Generate dataset creation script
    dataset_script = generate_dataset_creator(n_components, capability)
    
    return {
        'protocol': n_protocol,
        'dataset_script': dataset_script
    }
```

### Design Niveau C (Conversational Training)

```python
def design_c_protocol(c_components, capability):
    """
    Conversational training strategy for patterns
    """
    
    c_protocol = {
        'method': 'Interactive training with feedback loops',
        'training_phases': [],
        'feedback_mechanisms': [],
        'memory_integration': True,
        'schedule': 'Daily training sessions'
    }
    
    # For each pattern component
    for component in c_components:
        phase = {
            'name': f"Train {component}",
            'iterations': estimate_iterations(component),
            'examples': generate_example_scenarios(component, capability),
            'feedback_type': 'explicit corrections + implicit reinforcement'
        }
        c_protocol['training_phases'].append(phase)
    
    # Feedback loops
    c_protocol['feedback_mechanisms'] = [
        'User corrections (immediate)',
        'Success/failure tracking (per-interaction)',
        'Pattern retention tests (daily)'
    ]
    
    return c_protocol
```

### Design Niveau Cp (Intuition Activation)

```python
def design_cp_protocol(cp_components, capability):
    """
    Intuition kernel configuration
    """
    
    # Baseline corpus for anchoring
    baseline_corpus = select_baseline_corpus(capability['domain'], cp_components)
    
    # Threshold calibration
    mode = determine_optimal_mode(capability)  # exploration/balanced/technical
    
    cp_protocol = {
        'method': 'Kernel Cp activation',
        'baseline_corpus': baseline_corpus,
        'mode': mode,
        'thresholds': get_thresholds_for_mode(mode),
        'creative_temperature': 1.2 if mode == 'exploration' else 1.0,
        'validation': 'Human-in-loop creation vs hallucination checks',
        'monitoring': 'Real-time via monitoring_cp.py'
    }
    
    # Generate kernel file
    kernel_config = generate_cp_kernel(cp_protocol, capability)
    
    return {
        'protocol': cp_protocol,
        'kernel_config': kernel_config
    }
```

---

## STEP 4: Integration Architecture

**Connect three levels coherently:**

```python
def design_integration(n_protocol, c_protocol, cp_protocol, capability):
    """
    Ensure three levels work together
    """
    
    integration = {
        'execution_order': [],
        'dependencies': [],
        'synchronization': {}
    }
    
    # Typical order: N first (foundation), then C (patterns), then Cp (intuition)
    integration['execution_order'] = [
        {
            'level': 'N',
            'phase': 'Foundation',
            'duration': '1-2 weeks',
            'deliverable': 'Fine-tuned model with domain knowledge'
        },
        {
            'level': 'C',
            'phase': 'Operationalization',
            'duration': '3-5 days',
            'deliverable': 'Trained behavioral patterns',
            'depends_on': ['N complete']
        },
        {
            'level': 'Cp',
            'phase': 'Activation',
            'duration': '1 day',
            'deliverable': 'Creative emergence enabled',
            'depends_on': ['N complete', 'C stable']
        }
    ]
    
    # Dependencies
    integration['dependencies'] = {
        'C_requires_N': 'Patterns need foundation knowledge',
        'Cp_requires_N_and_C': 'Intuition needs both structure and behavior'
    }
    
    # Synchronization points
    integration['synchronization'] = {
        'after_N': 'Validate baseline capabilities before C training',
        'after_C': 'Test pattern stability before Cp activation',
        'ongoing': 'Monitor three-level balance (Δ_N ≈ Δ_C ≈ Δ_Cp)'
    }
    
    return integration
```

---

## STEP 5: Validation Suite

**Generate tests for each level:**

```python
def generate_validation_suite(capability, decomposition):
    """
    Create test cases per level
    """
    
    validation = {
        'N_tests': [],
        'C_tests': [],
        'Cp_tests': []
    }
    
    # Niveau N tests (capability retention)
    for component in decomposition['N']:
        test = {
            'component': component,
            'test_type': 'knowledge_check',
            'examples': generate_n_test_cases(component, capability),
            'success_threshold': '80% accuracy'
        }
        validation['N_tests'].append(test)
    
    # Niveau C tests (pattern execution)
    for component in decomposition['C']:
        test = {
            'component': component,
            'test_type': 'workflow_execution',
            'scenarios': generate_c_test_scenarios(component, capability),
            'success_threshold': '90% pattern retention'
        }
        validation['C_tests'].append(test)
    
    # Niveau Cp tests (creative emergence)
    for component in decomposition['Cp']:
        test = {
            'component': component,
            'test_type': 'creativity_check',
            'prompts': generate_cp_test_prompts(component, capability),
            'success_threshold': '>50% creation, <5% hallucination'
        }
        validation['Cp_tests'].append(test)
    
    return validation
```

---

## STEP 6: Documentation Generation

**Produce complete operational protocol:**

```python
def generate_protocol_document(capability, decomposition, n_protocol, 
                               c_protocol, cp_protocol, integration, validation):
    """
    Create comprehensive protocol document
    """
    
    doc = f"""
# PROTOCOLE FORMATION — {capability['name'].upper()}

**Version:** 1.0  
**Date:** {datetime.now().strftime('%Y-%m-%d')}  
**Capability Target:** {capability['description']}  
**Success Criteria:** {capability['success_criteria']}

---

## ARCHITECTURE TROIS NIVEAUX

### Niveau N (Structurel)
**Components:** {', '.join(decomposition['N'])}  
**Method:** {n_protocol['protocol']['method']}  
**Timeline:** {integration['execution_order'][0]['duration']}

{format_n_protocol(n_protocol)}

---

### Niveau C (Opérationnel)
**Components:** {', '.join(decomposition['C'])}  
**Method:** {c_protocol['method']}  
**Timeline:** {integration['execution_order'][1]['duration']}

{format_c_protocol(c_protocol)}

---

### Niveau Cp (Intuition)
**Components:** {', '.join(decomposition['Cp'])}  
**Method:** {cp_protocol['protocol']['method']}  
**Timeline:** {integration['execution_order'][2]['duration']}

{format_cp_protocol(cp_protocol)}

---

## INTÉGRATION

**Ordre exécution:**
{format_execution_order(integration['execution_order'])}

**Dépendances:**
{format_dependencies(integration['dependencies'])}

**Synchronisation:**
{format_synchronization(integration['synchronization'])}

---

## VALIDATION

{format_validation_suite(validation)}

---

## MONITORING

Setup dashboard monitoring trois niveaux:

```bash
python -m three_level_monitoring.setup
python monitoring_dashboard.py
```

Track metrics:
- Δ_N: {n_protocol['protocol']['validation']}
- Δ_C: Pattern retention rate
- Δ_Cp: Creation/hallucination ratio

---

## ROADMAP

**Week 1-2:** Niveau N fine-tuning  
**Week 3:** Niveau C conversational training  
**Week 4:** Niveau Cp activation + integration  
**Week 5:** Validation + calibration  

**Total timeline:** ~5 weeks to operational capability

---

**FIN PROTOCOLE**

Formation complète {capability['name']} via architecture trois niveaux.
"""
    
    return doc
```

---

## OUTPUT FILES

**Generate complete training package:**

1. **PROTOCOLE_FORMATION_{capability}.md** - Full protocol
2. **niveau_n_dataset_creator.py** - Dataset generation for fine-tuning
3. **niveau_c_training_script.py** - Conversational training workflow
4. **niveau_cp_kernel.md** - Intuition activation kernel
5. **validation_suite.py** - Tests for all levels
6. **monitoring_config.yaml** - Dashboard configuration
7. **README.md** - Quick start guide

**Present to user:**

```
✓ Protocole formation complet généré: {capability_name}

Structure:
├─ Niveau N: {n_duration} - {n_method}
├─ Niveau C: {c_duration} - {c_method}
└─ Niveau Cp: {cp_duration} - {cp_method}

Success criteria: {success_criteria}
Total timeline: ~{total_weeks} weeks

Files ready:
- Protocol documentation
- Training scripts
- Validation suite
- Monitoring setup

Next steps:
1. Review protocol
2. Prepare datasets
3. Execute N → C → Cp
4. Monitor & validate
```

---

## EXAMPLES

**Capabilities successfully formalized:**
- Medical diagnosis (domain knowledge + clinical reasoning)
- Code review (technical + style + best practices)
- Creative writing (structure + voice + originality)
- Financial analysis (data + patterns + insights)

**Template works for:**
- Technical skills (coding, engineering, analysis)
- Creative skills (writing, design, ideation)
- Domain expertise (medical, legal, financial)
- Soft skills (communication, empathy, coaching)

---

## ANTI-PATTERNS

❌ **Skip level decomposition:** Can't train coherently without N/C/Cp mapping
❌ **Execute out of order:** C before N = unstable patterns
❌ **No validation suite:** Can't measure success
❌ **Ignore integration:** Three levels work independently = inefficient
❌ **Unrealistic timeline:** Some capabilities need months, not weeks

---

**FIN SKILL**

Meta-protocol generator for industrialized AI formation across any capability.
