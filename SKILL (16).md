---
name: feedback-integrator
description: Integrate feedback into any system to improve performance. Use for "intégrer feedback", "learn from corrections", "update based on results", "adaptive system", or any workflow where feedback should modify behavior. Universal pattern for feedback loops in any domain.
---

# FEEDBACK INTEGRATOR

Universal pattern for integrating feedback into systems.

## Core Pattern

```python
def integrate_feedback(
    system_state,
    feedback,
    integration_strategy='weighted_average',
    learning_rate=0.1
):
    """
    Update system based on feedback
    
    Args:
        system_state: Current state (dict, array, model)
        feedback: Signal to integrate (score, correction, gradient)
        integration_strategy: How to merge feedback
        learning_rate: How much to change
        
    Returns:
        updated_state
    """
    
    if integration_strategy == 'weighted_average':
        return weighted_average_update(system_state, feedback, learning_rate)
    
    elif integration_strategy == 'gradient':
        return gradient_update(system_state, feedback, learning_rate)
    
    elif integration_strategy == 'replacement':
        return replace_on_improvement(system_state, feedback)
    
    elif integration_strategy == 'accumulation':
        return accumulate_feedback(system_state, feedback)

def weighted_average_update(state, feedback, lr):
    """Smooth integration"""
    return (1 - lr) * state + lr * feedback

def gradient_update(state, feedback, lr):
    """Gradient-based update"""
    gradient = compute_gradient(state, feedback)
    return state - lr * gradient

def replace_on_improvement(state, feedback):
    """Only replace if better"""
    if evaluate(feedback) > evaluate(state):
        return feedback
    return state

def accumulate_feedback(state, feedback):
    """Add to running total"""
    if not hasattr(state, 'feedback_history'):
        state.feedback_history = []
    state.feedback_history.append(feedback)
    return aggregate_feedback(state.feedback_history)
```

## Example 1: Update Model Weights

```python
# Integrate training feedback
model_weights = integrate_feedback(
    system_state=current_weights,
    feedback=gradient_from_batch,
    integration_strategy='gradient',
    learning_rate=0.001
)
```

## Example 2: Adjust Strategy Parameters

```python
# User says "too aggressive"
current_strategy = {'risk': 0.8, 'position_size': 0.5}
feedback = {'risk': 0.5, 'position_size': 0.3}  # Suggested correction

updated_strategy = integrate_feedback(
    system_state=current_strategy,
    feedback=feedback,
    integration_strategy='weighted_average',
    learning_rate=0.3  # 30% toward suggestion
)
```

## Example 3: Improve Predictions

```python
# Prediction was wrong, integrate correction
prediction_model = integrate_feedback(
    system_state=model,
    feedback={'actual': 100, 'predicted': 80},
    integration_strategy='gradient',
    learning_rate=0.01
)
```

---

**FIN SKILL**
