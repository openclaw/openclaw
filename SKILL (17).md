---
name: pattern-extractor
description: Extract patterns from data, results, or observations. Use for "trouve patterns", "identify trends", "extract rules", "discover regularities", or any analysis requiring pattern discovery. Universal pattern recognition across any domain.
---

# PATTERN EXTRACTOR

Universal pattern discovery from data.

## Core Pattern

```python
def extract_patterns(
    data,
    pattern_type='frequency',  # frequency, correlation, sequence, cluster
    min_support=0.1,
    min_confidence=0.5
):
    """
    Discover patterns in data
    
    Returns:
        List of patterns with confidence scores
    """
    
    if pattern_type == 'frequency':
        return find_frequent_patterns(data, min_support)
    
    elif pattern_type == 'correlation':
        return find_correlations(data, min_confidence)
    
    elif pattern_type == 'sequence':
        return find_sequential_patterns(data, min_support)
    
    elif pattern_type == 'cluster':
        return find_clusters(data)
    
    elif pattern_type == 'anomaly':
        return find_anomalies(data)

def find_frequent_patterns(data, min_support):
    """Items/events that occur frequently"""
    from collections import Counter
    counts = Counter(data)
    total = len(data)
    
    patterns = []
    for item, count in counts.items():
        support = count / total
        if support >= min_support:
            patterns.append({
                'pattern': item,
                'support': support,
                'count': count
            })
    
    return sorted(patterns, key=lambda p: p['support'], reverse=True)

def find_correlations(data, min_confidence):
    """Variables that correlate"""
    import numpy as np
    correlations = []
    
    for i in range(len(data[0])):
        for j in range(i+1, len(data[0])):
            corr = np.corrcoef(data[:,i], data[:,j])[0,1]
            if abs(corr) >= min_confidence:
                correlations.append({
                    'variables': (i, j),
                    'correlation': corr
                })
    
    return correlations

def find_sequential_patterns(sequences, min_support):
    """Common sequences"""
    from collections import defaultdict
    
    sequence_counts = defaultdict(int)
    
    for seq in sequences:
        for length in range(2, len(seq)+1):
            for start in range(len(seq) - length + 1):
                subseq = tuple(seq[start:start+length])
                sequence_counts[subseq] += 1
    
    total = len(sequences)
    patterns = []
    
    for seq, count in sequence_counts.items():
        support = count / total
        if support >= min_support:
            patterns.append({
                'sequence': seq,
                'support': support,
                'count': count
            })
    
    return sorted(patterns, key=lambda p: p['support'], reverse=True)
```

## Example: Extract Success Patterns

```python
# From trial history
trials = [
    {'params': {'lr': 0.01, 'batch': 32}, 'success': True},
    {'params': {'lr': 0.01, 'batch': 64}, 'success': True},
    {'params': {'lr': 0.001, 'batch': 32}, 'success': False},
]

# What makes trials successful?
patterns = extract_patterns(
    [t for t in trials if t['success']],
    pattern_type='frequency'
)
# → Pattern: lr=0.01 appears in all successes
```

---

**FIN SKILL**
