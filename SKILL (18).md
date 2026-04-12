---
name: convergence-detector
description: Detect when iterative process has converged. Use for "détecte convergence", "check if stable", "stop condition", "plateau detection", or any workflow needing automatic stopping. Universal convergence detection across optimization, training, iteration.
---

# CONVERGENCE DETECTOR

Universal convergence detection for iterative processes.

## Core Pattern

```python
def has_converged(
    history,
    method='variance',  # variance, delta, plateau, oscillation
    window=10,
    tolerance=0.01
):
    """
    Check if process has converged
    
    Args:
        history: List of values over time
        method: Detection method
        window: Recent values to check
        tolerance: Convergence threshold
        
    Returns:
        bool, convergence_info
    """
    
    if len(history) < window:
        return False, {'reason': 'insufficient_data'}
    
    recent = history[-window:]
    
    if method == 'variance':
        return variance_convergence(recent, tolerance)
    
    elif method == 'delta':
        return delta_convergence(recent, tolerance)
    
    elif method == 'plateau':
        return plateau_convergence(history, window, tolerance)
    
    elif method == 'oscillation':
        return oscillation_convergence(recent, tolerance)

def variance_convergence(recent, tolerance):
    """Low variance = converged"""
    variance = np.var(recent)
    converged = variance < tolerance
    return converged, {'variance': variance, 'threshold': tolerance}

def delta_convergence(recent, tolerance):
    """Small changes = converged"""
    deltas = [abs(recent[i+1] - recent[i]) for i in range(len(recent)-1)]
    avg_delta = np.mean(deltas)
    converged = avg_delta < tolerance
    return converged, {'avg_delta': avg_delta, 'threshold': tolerance}

def plateau_convergence(history, window, tolerance):
    """No improvement = plateau"""
    best_overall = max(history)
    best_recent = max(history[-window:])
    improvement = best_recent - best_overall
    converged = improvement < tolerance
    return converged, {'improvement': improvement, 'threshold': tolerance}

def oscillation_convergence(recent, tolerance):
    """Stable oscillation = converged"""
    # Check if oscillating around stable mean
    mean = np.mean(recent)
    deviations = [abs(v - mean) for v in recent]
    max_deviation = max(deviations)
    converged = max_deviation < tolerance
    return converged, {'max_deviation': max_deviation, 'mean': mean}
```

## Example: Training Convergence

```python
training_losses = [0.5, 0.3, 0.25, 0.23, 0.22, 0.221, 0.220, 0.219]

converged, info = has_converged(
    training_losses,
    method='delta',
    window=5,
    tolerance=0.01
)

if converged:
    print(f"Training converged: {info}")
    stop_training()
```

---

**FIN SKILL**
