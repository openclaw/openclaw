---
name: spatial-learning-converter
description: Transform sequential datasets into spatial navigation format compatible with Cp geometry. Use when user asks "convertis dataset séquentiel → spatial", "adapt dataset pour TEMPUS", "déséquentialise données", "rescue sequential dataset", or needs to reformat existing chronological datasets for intemporality-respecting training. Saves datasets that were built sequentially.
---

# SPATIAL LEARNING CONVERTER

Rescue sequential datasets by converting to spatial navigation format.

## Problem

Most ML datasets are structured sequentially:
```
data = [event_1, event_2, event_3, ..., event_n]
training_order = [1, 2, 3, ..., n]  # Chronological
```

This forces AI to learn temporal patterns, not causal laws.

## Solution

Convert to spatial access:
```
data = {T1: event_1, T2: event_2, ..., Tn: event_n}
training_order = random.sample([T1, T2, ..., Tn])  # Spatial
```

## Conversion Workflow

```python
def convert_sequential_to_spatial(sequential_dataset, config):
    """
    Transform sequential dataset → spatial TEMPUS format
    """
    
    # 1. Parse sequential structure
    parsed = parse_sequential_dataset(sequential_dataset)
    
    # 2. Extract timestamps
    temporal_index = extract_temporal_index(parsed)
    
    # 3. Create spatial mapping
    spatial_dataset = create_spatial_mapping(parsed, temporal_index)
    
    # 4. Generate TEMPUS datapoints
    tempus_dataset = generate_tempus_datapoints(
        spatial_dataset, 
        config['delta'], 
        config['epsilon']
    )
    
    # 5. Verify spatial properties
    verify_spatial_conversion(tempus_dataset)
    
    return tempus_dataset

def parse_sequential_dataset(dataset):
    """
    Understand sequential structure
    """
    
    # Detect format
    if isinstance(dataset, list):
        # List of events
        return {
            'format': 'list',
            'length': len(dataset),
            'items': dataset
        }
    
    elif isinstance(dataset, pd.DataFrame):
        # DataFrame
        return {
            'format': 'dataframe',
            'length': len(dataset),
            'items': dataset.to_dict('records')
        }
    
    elif 'csv' in str(dataset) or 'json' in str(dataset):
        # File path
        data = load_file(dataset)
        return parse_sequential_dataset(data)

def extract_temporal_index(parsed):
    """
    Find or create temporal index
    """
    
    items = parsed['items']
    
    # Try to find existing timestamp field
    timestamp_fields = ['timestamp', 'date', 'time', 'datetime', 'created_at']
    
    for field in timestamp_fields:
        if field in items[0]:
            print(f"✓ Found timestamp field: {field}")
            return {
                'field': field,
                'timestamps': [item[field] for item in items]
            }
    
    # If no timestamp, create index
    print("⚠ No timestamp found - creating artificial index")
    return {
        'field': 'index',
        'timestamps': list(range(len(items)))
    }

def create_spatial_mapping(parsed, temporal_index):
    """
    Map items to spatial dictionary
    """
    
    spatial = {}
    
    for item, timestamp in zip(parsed['items'], temporal_index['timestamps']):
        spatial[timestamp] = item
    
    print(f"✓ Created spatial mapping: {len(spatial)} points")
    
    return spatial

def generate_tempus_datapoints(spatial_dataset, delta, epsilon):
    """
    Create TEMPUS datapoints with Δ/δ windows
    """
    
    timestamps = sorted(spatial_dataset.keys())
    
    # Valid T₁ range (must have delta before, epsilon after)
    T1_valid = []
    for i, T1 in enumerate(timestamps):
        # Check delta context available
        if i < delta:
            continue  # Not enough context
        
        # Check epsilon future available
        if i + epsilon >= len(timestamps):
            continue  # Not enough future
        
        T1_valid.append(T1)
    
    # Random sampling of T₁ points
    n_samples = min(100, len(T1_valid))
    sampled_T1 = random.sample(T1_valid, n_samples)
    
    # Create datapoints
    dataset = []
    for T1 in sampled_T1:
        T1_idx = timestamps.index(T1)
        
        # Context [T1-Δ, T1]
        context_indices = range(T1_idx - delta, T1_idx + 1)
        context = [spatial_dataset[timestamps[i]] for i in context_indices]
        
        # Ground truth [T1, T1+δ]
        ground_truth_indices = range(T1_idx, T1_idx + epsilon + 1)
        ground_truth = [spatial_dataset[timestamps[i]] for i in ground_truth_indices]
        
        dataset.append({
            'T1': T1,
            'context_pre': context,
            'ground_truth_post': ground_truth,
            'blackout_enforced': True
        })
    
    print(f"✓ Generated {len(dataset)} TEMPUS datapoints")
    
    return dataset

def verify_spatial_conversion(dataset):
    """
    Verify spatial properties
    """
    
    # Check 1: Non-sequential sampling
    T1_points = [d['T1'] for d in dataset]
    sorted_T1 = sorted(T1_points)
    
    is_sequential = (T1_points == sorted_T1)
    
    if is_sequential:
        print("⚠ Warning: T₁ points are sequential - re-shuffle!")
        random.shuffle(dataset)
    
    # Check 2: Blackout enforced
    all_blackout = all(d['blackout_enforced'] for d in dataset)
    
    if not all_blackout:
        print("❌ Error: Blackout not enforced")
        return False
    
    # Check 3: Context < T₁
    for d in dataset:
        T1 = d['T1']
        for item in d['context_pre']:
            if item.get('timestamp', 0) > T1:
                print(f"❌ Error: Future leakage at T1={T1}")
                return False
    
    print("✓ Spatial conversion verified")
    return True
```

## Example Usage

```python
# Original sequential dataset
sequential_data = pd.read_csv('hockey_games_sequential.csv')
# Rows ordered chronologically: game 1, game 2, game 3...

# Convert to spatial TEMPUS format
tempus_data = convert_sequential_to_spatial(
    sequential_data,
    config={'delta': 15, 'epsilon': 1}
)

# Now spatially navigable
# Can train with random T₁ jumps
# Respects Cp geometry

# Save
export_tempus_dataset(tempus_data, 'hockey_spatial_tempus.jsonl')
```

## Anti-Patterns Rescued

```python
# Pattern 1: Time series chronological training
# BEFORE:
for i in range(len(timeseries)):
    train(timeseries[i:i+window])

# AFTER:
converted = convert_sequential_to_spatial(timeseries, config)
tempus_train(converted)

# Pattern 2: Sequence-to-sequence
# BEFORE:
for seq in sequences:
    train_seq2seq(seq)  # Sequential

# AFTER:
converted = convert_sequential_to_spatial(sequences, config)
tempus_train(converted)

# Pattern 3: Video frames
# BEFORE:
for frame_t in range(len(video)):
    train(video[frame_t], video[frame_t+1])

# AFTER:
converted = convert_sequential_to_spatial(video, config)
tempus_train(converted)
```

---

**FIN SKILL**

Spatial converter - rescues sequential datasets for Cp-compliant training.

**🎉 TOUS LES 15 SKILLS CRÉÉS! 🎉**
