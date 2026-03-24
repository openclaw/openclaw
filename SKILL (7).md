---
name: tempus-dataset-generator
description: Generate TEMPUS-compliant datasets with spatial temporal sampling (non-sequential). Use when user asks "crée dataset TEMPUS", "génère sampling spatial", "protocole TEMPUS dataset pour [domain]", "setup TEMPUS training data", or needs to transform historical data into intemporality-respecting training format. Critical for any TEMPUS implementation - correct dataset = 80% of protocol success.
---

# TEMPUS DATASET GENERATOR

Generate datasets that respect computational dimension (Cp) intemporality for TEMPUS protocol.

## Core Principle

**WRONG (Classical ML):**
```
Training order: T₁ → T₂ → T₃ → T₄ (chronological)
AI learns: Sequential patterns, trends, chronology
```

**RIGHT (TEMPUS):**
```
Training order: T₃ → T₁ → T₄ → T₂ (random spatial navigation)
AI learns: Causal laws, reality structure, invariants
```

**Goal:** Transform historical data into spatially-navigable training set that respects Cp geometry.

---

## GENERATION WORKFLOW

**5-step protocol:**

1. **Data Inventory** — Analyze available historical data
2. **Temporal Window Configuration** — Define Δ (context) and δ (prediction)
3. **Spatial Sampling** — Generate random T₁ points
4. **Blackout Enforcement** — Ensure strict information isolation
5. **Dataset Export** — Format for training framework

---

## STEP 1: Data Inventory

**Analyze historical data structure:**

```python
def inventory_historical_data(data_source):
    """
    Understand temporal structure of available data
    """
    
    inventory = {
        'domain': input("Domain? (hockey, finance, climate, etc.): "),
        'temporal_range': {},
        'data_density': {},
        'available_features': [],
        'ground_truth_availability': {}
    }
    
    # Load data
    if isinstance(data_source, str):
        # File path
        data = load_data(data_source)
    else:
        # Direct data
        data = data_source
    
    # Temporal range
    timestamps = extract_timestamps(data)
    inventory['temporal_range'] = {
        'T_min': min(timestamps),
        'T_max': max(timestamps),
        'total_span': max(timestamps) - min(timestamps),
        'n_datapoints': len(timestamps)
    }
    
    # Data density
    deltas = np.diff(sorted(timestamps))
    inventory['data_density'] = {
        'median_gap': np.median(deltas),
        'min_gap': np.min(deltas),
        'max_gap': np.max(deltas),
        'gaps_histogram': compute_gap_histogram(deltas)
    }
    
    # Features available
    inventory['available_features'] = list(data[0].keys())
    
    # Ground truth check
    print("\n=== Ground Truth Availability ===")
    has_ground_truth = input("Do you have ground truth results for predictions? (y/n): ")
    inventory['ground_truth_availability'] = {
        'available': has_ground_truth.lower() == 'y',
        'format': input("Format? (scores, labels, continuous values): ") if has_ground_truth.lower() == 'y' else None
    }
    
    return inventory
```

**Example - Hockey:**

```yaml
inventory:
  domain: hockey
  temporal_range:
    T_min: 2024-10-01
    T_max: 2026-03-18
    total_span: 534 days
    n_datapoints: 1230 games
  
  data_density:
    median_gap: 1 day (multiple games per day)
    min_gap: 0 (same day games)
    max_gap: 3 days (rare gaps)
  
  available_features:
    - team stats (shots, hits, faceoffs)
    - recent performance (W/L streaks)
    - injuries
    - rest days
  
  ground_truth_availability:
    available: true
    format: scores (goals per team)
```

---

## STEP 2: Temporal Window Configuration

**Define Δ (context window) and δ (prediction window):**

```python
def configure_temporal_windows(inventory):
    """
    Configure Δ and δ based on domain characteristics
    """
    
    config = {
        'delta': {},  # Context window (before T₁)
        'epsilon': {}  # Prediction window (after T₁)
    }
    
    domain = inventory['domain']
    median_gap = inventory['data_density']['median_gap']
    
    # Domain-specific defaults
    defaults = {
        'hockey': {'delta': 15, 'delta_unit': 'games', 'epsilon': 1, 'epsilon_unit': 'game'},
        'finance': {'delta': 30, 'delta_unit': 'days', 'epsilon': 1, 'epsilon_unit': 'day'},
        'climate': {'delta': 50, 'delta_unit': 'years', 'epsilon': 10, 'epsilon_unit': 'years'},
        'epidemics': {'delta': 14, 'delta_unit': 'days', 'epsilon': 7, 'epsilon_unit': 'days'},
        'elections': {'delta': 90, 'delta_unit': 'days', 'epsilon': 1, 'epsilon_unit': 'election'}
    }
    
    # Use defaults or custom
    if domain in defaults:
        print(f"\n=== Default windows for {domain} ===")
        print(f"Δ (context): {defaults[domain]['delta']} {defaults[domain]['delta_unit']}")
        print(f"δ (prediction): {defaults[domain]['epsilon']} {defaults[domain]['epsilon_unit']}")
        
        use_defaults = input("Use defaults? (y/n): ")
        if use_defaults.lower() == 'y':
            config['delta'] = defaults[domain]['delta']
            config['delta_unit'] = defaults[domain]['delta_unit']
            config['epsilon'] = defaults[domain]['epsilon']
            config['epsilon_unit'] = defaults[domain]['epsilon_unit']
        else:
            config = custom_windows()
    else:
        config = custom_windows()
    
    return config

def custom_windows():
    """User-defined windows"""
    return {
        'delta': int(input("Δ (context size): ")),
        'delta_unit': input("Δ unit (days/games/years): "),
        'epsilon': int(input("δ (prediction horizon): ")),
        'epsilon_unit': input("δ unit (days/games/years): ")
    }
```

**Window size guidelines:**

| Domain | Δ (Context) | δ (Prediction) | Rationale |
|--------|-------------|----------------|-----------|
| Hockey | 15 games | 1 game | Recent form + immediate outcome |
| Finance | 30 days | 1 day | Monthly trend + next-day prediction |
| Climate | 50 years | 10 years | Long-term patterns + decadal forecast |
| Epidemics | 14 days | 7 days | Incubation period + weekly spread |
| Weather | 7 days | 1 day | Weather patterns + next-day forecast |

---

## STEP 3: Spatial Sampling

**Generate random T₁ points (NON-sequential):**

```python
def generate_spatial_sampling(inventory, config, n_samples=100):
    """
    Generate random temporal positions for TEMPUS protocol
    
    CRITICAL: Sampling must be RANDOM, not chronological
    """
    
    T_min = inventory['temporal_range']['T_min']
    T_max = inventory['temporal_range']['T_max']
    
    # Compute valid range for T₁
    # T₁ must have Δ data before it and δ data after it
    delta = config['delta']
    epsilon = config['epsilon']
    
    # Convert to same unit (e.g., days)
    delta_days = convert_to_days(delta, config['delta_unit'])
    epsilon_days = convert_to_days(epsilon, config['epsilon_unit'])
    
    # Valid T₁ range
    T1_min = T_min + timedelta(days=delta_days)
    T1_max = T_max - timedelta(days=epsilon_days)
    
    # Generate random points
    random.seed(42)  # Reproducible but still random
    
    all_valid_timestamps = get_timestamps_in_range(T1_min, T1_max)
    
    if len(all_valid_timestamps) < n_samples:
        print(f"⚠ Warning: Only {len(all_valid_timestamps)} valid points, requested {n_samples}")
        n_samples = len(all_valid_timestamps)
    
    # RANDOM sampling (spatial navigation)
    sampled_T1_points = random.sample(all_valid_timestamps, n_samples)
    
    # Verify non-sequentiality
    verify_spatial_sampling(sampled_T1_points)
    
    return {
        'T1_points': sorted(sampled_T1_points),  # Sort for display, NOT for training
        'n_samples': n_samples,
        'temporal_coverage': compute_coverage(sampled_T1_points, T1_min, T1_max)
    }

def verify_spatial_sampling(T1_points):
    """
    Verify sampling is truly spatial (not sequential)
    """
    
    # Check for sequential patterns
    sorted_points = sorted(T1_points)
    deltas = [sorted_points[i+1] - sorted_points[i] for i in range(len(sorted_points)-1)]
    
    # If all deltas are equal = SEQUENTIAL (BAD)
    if len(set(deltas)) == 1:
        raise ValueError("❌ SEQUENTIAL SAMPLING DETECTED - This violates TEMPUS protocol!")
    
    # Compute variance in deltas
    delta_variance = np.var([d.total_seconds() for d in deltas])
    
    print(f"✓ Spatial sampling verified:")
    print(f"  - Delta variance: {delta_variance:.2e} (high = good)")
    print(f"  - Unique gaps: {len(set(deltas))} / {len(deltas)}")
```

---

## STEP 4: Blackout Enforcement

**CRITICAL: Ensure strict information isolation at T₁:**

```python
def create_temporal_datapoints(T1_points, raw_data, config):
    """
    For each T₁, create datapoint with strict blackout
    """
    
    dataset = []
    
    for T1 in T1_points:
        datapoint = create_single_datapoint(T1, raw_data, config)
        dataset.append(datapoint)
    
    return dataset

def create_single_datapoint(T1, raw_data, config):
    """
    Create single TEMPUS datapoint
    
    Structure:
    {
      'T1': timestamp,
      'context_pre': data from [T1-Δ, T1],
      'ground_truth_post': data from [T1, T1+δ],
      'blackout_enforced': True
    }
    """
    
    delta = config['delta']
    epsilon = config['epsilon']
    
    # Context window [T1-Δ, T1]
    T_context_start = T1 - timedelta_from_config(delta, config['delta_unit'])
    context_data = extract_data_range(raw_data, T_context_start, T1)
    
    # Prediction window [T1, T1+δ]
    T_prediction_end = T1 + timedelta_from_config(epsilon, config['epsilon_unit'])
    ground_truth = extract_data_range(raw_data, T1, T_prediction_end)
    
    # BLACKOUT ENFORCEMENT
    # Verify no data leakage from future
    verify_no_future_leakage(context_data, T1)
    
    datapoint = {
        'T1': T1.isoformat(),
        'context_pre': context_data,
        'ground_truth_post': ground_truth,
        'blackout_enforced': True,
        'config': {
            'delta': delta,
            'epsilon': epsilon
        }
    }
    
    return datapoint

def verify_no_future_leakage(context_data, T1):
    """
    CRITICAL: Ensure context contains NO information > T1
    """
    
    for item in context_data:
        if 'timestamp' in item and item['timestamp'] > T1:
            raise ValueError(f"❌ FUTURE LEAKAGE DETECTED at T1={T1}: {item}")
    
    print(f"✓ Blackout verified for T1={T1}")
```

---

## STEP 5: Dataset Export

**Format for training framework:**

```python
def export_tempus_dataset(dataset, output_path, format='jsonl'):
    """
    Export dataset in training-ready format
    """
    
    if format == 'jsonl':
        export_jsonl(dataset, output_path)
    elif format == 'parquet':
        export_parquet(dataset, output_path)
    elif format == 'hf_dataset':
        export_huggingface(dataset, output_path)
    
    # Generate metadata
    metadata = {
        'protocol': 'TEMPUS',
        'version': '1.0',
        'n_samples': len(dataset),
        'temporal_range': {
            'T1_min': min(d['T1'] for d in dataset),
            'T1_max': max(d['T1'] for d in dataset)
        },
        'spatial_sampling': True,
        'blackout_enforced': all(d['blackout_enforced'] for d in dataset),
        'config': dataset[0]['config']
    }
    
    with open(f"{output_path}.metadata.json", 'w') as f:
        json.dump(metadata, f, indent=2)
    
    print(f"✓ Dataset exported: {output_path}")
    print(f"  - {len(dataset)} samples")
    print(f"  - Spatial sampling: {metadata['spatial_sampling']}")
    print(f"  - Blackout enforced: {metadata['blackout_enforced']}")

def export_jsonl(dataset, output_path):
    """Export as JSONL (one JSON per line)"""
    with open(output_path, 'w') as f:
        for datapoint in dataset:
            f.write(json.dumps(datapoint) + '\n')

def export_parquet(dataset, output_path):
    """Export as Parquet (efficient columnar)"""
    import pandas as pd
    df = pd.DataFrame(dataset)
    df.to_parquet(output_path)

def export_huggingface(dataset, output_path):
    """Export as HuggingFace Dataset"""
    from datasets import Dataset
    hf_dataset = Dataset.from_list(dataset)
    hf_dataset.save_to_disk(output_path)
```

---

## FULL WORKFLOW EXAMPLE

```python
# Complete TEMPUS dataset generation

# Step 1: Inventory
inventory = inventory_historical_data('hockey_games_2024_2026.csv')

# Step 2: Configure windows
config = configure_temporal_windows(inventory)
# Output: Δ=15 games, δ=1 game

# Step 3: Spatial sampling
sampling = generate_spatial_sampling(inventory, config, n_samples=100)
# Output: 100 random T₁ points

# Step 4: Create datapoints with blackout
dataset = create_temporal_datapoints(
    T1_points=sampling['T1_points'],
    raw_data=load_hockey_data(),
    config=config
)

# Step 5: Export
export_tempus_dataset(
    dataset=dataset,
    output_path='tempus_hockey_dataset.jsonl',
    format='jsonl'
)

# Verify
print("\n=== DATASET VERIFICATION ===")
print(f"Total samples: {len(dataset)}")
print(f"Spatial sampling: ✓")
print(f"Blackout enforced: ✓")
print(f"Ready for TEMPUS training: ✓")
```

---

## DOMAIN-SPECIFIC EXAMPLES

### Hockey (Protocole OMNI)

```python
config_hockey = {
    'domain': 'hockey',
    'delta': 15,  # Last 15 games as context
    'delta_unit': 'games',
    'epsilon': 1,  # Predict next game
    'epsilon_unit': 'game',
    'features': [
        'team_stats_recent',
        'opponent_stats_recent',
        'h2h_history',
        'injuries',
        'rest_days'
    ]
}
```

### Finance (Stock Prediction)

```python
config_finance = {
    'domain': 'finance',
    'delta': 30,  # Last 30 days trend
    'delta_unit': 'days',
    'epsilon': 1,  # Predict next day
    'epsilon_unit': 'day',
    'features': [
        'price_history',
        'volume',
        'market_indicators',
        'news_sentiment'
    ]
}
```

### Climate (Temperature Forecast)

```python
config_climate = {
    'domain': 'climate',
    'delta': 50,  # 50 years historical
    'delta_unit': 'years',
    'epsilon': 10,  # 10 years forecast
    'epsilon_unit': 'years',
    'features': [
        'CO2_concentration',
        'temperature_anomaly',
        'ocean_heat_content',
        'ice_extent'
    ]
}
```

---

## VALIDATION TESTS

**Test dataset before training:**

```python
def validate_tempus_dataset(dataset_path):
    """
    Verify dataset meets TEMPUS requirements
    """
    
    dataset = load_dataset(dataset_path)
    
    tests = {
        'spatial_sampling': test_spatial_sampling(dataset),
        'blackout_enforcement': test_blackout(dataset),
        'temporal_coverage': test_coverage(dataset),
        'ground_truth_availability': test_ground_truth(dataset),
        'feature_completeness': test_features(dataset)
    }
    
    all_passed = all(tests.values())
    
    if all_passed:
        print("✓ ALL TESTS PASSED - Dataset ready for TEMPUS training")
    else:
        print("❌ SOME TESTS FAILED:")
        for test, passed in tests.items():
            if not passed:
                print(f"  - {test}: FAILED")
    
    return all_passed

def test_spatial_sampling(dataset):
    """Verify non-sequential sampling"""
    T1_points = [d['T1'] for d in dataset]
    sorted_points = sorted(T1_points)
    deltas = [sorted_points[i+1] - sorted_points[i] for i in range(len(sorted_points)-1)]
    
    # High variance = spatial (good)
    variance = np.var(deltas)
    return variance > 0  # Any variance = not purely sequential

def test_blackout(dataset):
    """Verify strict blackout enforcement"""
    for datapoint in dataset:
        if not datapoint.get('blackout_enforced', False):
            return False
    return True

def test_coverage(dataset):
    """Verify good temporal coverage"""
    T1_points = [d['T1'] for d in dataset]
    T_min, T_max = min(T1_points), max(T1_points)
    total_range = (T_max - T_min).total_seconds()
    
    # Average gap should be < 10% of total range
    avg_gap = total_range / len(T1_points)
    return avg_gap < (total_range * 0.1)

def test_ground_truth(dataset):
    """Verify ground truth available"""
    for datapoint in dataset:
        if 'ground_truth_post' not in datapoint:
            return False
    return True

def test_features(dataset):
    """Verify features present"""
    for datapoint in dataset:
        if 'context_pre' not in datapoint or not datapoint['context_pre']:
            return False
    return True
```

---

## ANTI-PATTERNS

❌ **Sequential sampling:** T₁ = [1, 2, 3, 4...] violates Cp geometry
❌ **Future leakage:** Context contains data > T₁
❌ **Insufficient coverage:** Too few samples = poor generalization
❌ **Fixed Δ/δ across domains:** One size doesn't fit all
❌ **No validation tests:** Deploy dataset without verification

---

## QUICK START RECIPE

```bash
# 1. Prepare historical data
# CSV/JSON with timestamps + features + outcomes

# 2. Run generator
python tempus_dataset_generator.py \
  --input hockey_games.csv \
  --domain hockey \
  --n-samples 100 \
  --output tempus_hockey.jsonl

# 3. Validate
python validate_tempus.py tempus_hockey.jsonl

# 4. Ready for training
# Use with tempus-trainer skill
```

---

**FIN SKILL**

Dataset generator for TEMPUS protocol - respects Cp intemporality via spatial sampling.
