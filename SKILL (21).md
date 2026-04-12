---
name: hypothesis-tester
description: Test hypotheses empirically. Use for "teste hypothèse", "validate assumption", "A/B test", "empirical verification", or any workflow requiring hypothesis validation. Universal scientific method pattern.
---

# HYPOTHESIS TESTER

Universal empirical hypothesis testing.

## Core Pattern

```python
def test_hypothesis(
    hypothesis,
    test_function,
    sample_size=100,
    significance_level=0.05
):
    """
    Test hypothesis empirically
    
    Args:
        hypothesis: Statement to test
        test_function: () -> observation
        sample_size: Number of tests
        significance_level: P-value threshold
        
    Returns:
        result, statistics
    """
    
    # Collect observations
    observations = [test_function() for _ in range(sample_size)]
    
    # Statistical test
    if hypothesis['type'] == 'comparison':
        result = comparison_test(observations, hypothesis, significance_level)
    
    elif hypothesis['type'] == 'correlation':
        result = correlation_test(observations, hypothesis, significance_level)
    
    elif hypothesis['type'] == 'distribution':
        result = distribution_test(observations, hypothesis, significance_level)
    
    return result

def ab_test(variant_a, variant_b, metric_function, n_samples=1000):
    """
    Compare two variants
    
    Returns:
        winner, confidence, statistics
    """
    
    # Collect metrics
    results_a = [metric_function(variant_a) for _ in range(n_samples)]
    results_b = [metric_function(variant_b) for _ in range(n_samples)]
    
    # Statistical test
    from scipy import stats
    t_stat, p_value = stats.ttest_ind(results_a, results_b)
    
    mean_a = np.mean(results_a)
    mean_b = np.mean(results_b)
    
    if p_value < 0.05:
        winner = 'A' if mean_a > mean_b else 'B'
        confidence = 1 - p_value
    else:
        winner = 'no_difference'
        confidence = 0
    
    return {
        'winner': winner,
        'confidence': confidence,
        'mean_a': mean_a,
        'mean_b': mean_b,
        'p_value': p_value
    }

def sequential_test(hypothesis, test_function, max_samples=1000, alpha=0.05, beta=0.2):
    """
    Sequential hypothesis testing (stop early if clear result)
    """
    
    observations = []
    
    for n in range(max_samples):
        obs = test_function()
        observations.append(obs)
        
        if n >= 10:  # Minimum samples
            # Check if can reject/accept hypothesis
            result = check_hypothesis(observations, hypothesis, alpha, beta)
            
            if result['decision'] != 'continue':
                return result
    
    return {'decision': 'inconclusive', 'samples': observations}
```

## Example: Test Strategy Improvement

```python
# Hypothesis: New strategy performs better
hypothesis = {
    'type': 'comparison',
    'claim': 'new_strategy > old_strategy'
}

def test_function():
    old_result = run_strategy(old_strategy)
    new_result = run_strategy(new_strategy)
    return {'old': old_result, 'new': new_result}

result = test_hypothesis(
    hypothesis,
    test_function,
    sample_size=100
)

if result['p_value'] < 0.05:
    print(f"Hypothesis confirmed: {result}")
```

---

**FIN SKILL**
