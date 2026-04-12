---
name: trial-error-loop
description: Universal trial-and-error learning loop. Use when user needs "apprentissage essai-erreur", "trial and error optimization", "iterative testing", "learn by doing", or any workflow requiring repeated attempts with feedback. Works for any domain - parameter tuning, strategy optimization, skill learning, system calibration. Core primitive underlying all empirical learning.
---

# TRIAL-ERROR LOOP

Universal pattern for learning through experimentation.

## Core Pattern

```python
def trial_error_loop(
    trial_function,      # What to try
    evaluate_function,   # How to measure success
    improve_function,    # How to adjust based on result
    stop_criteria,       # When to stop
    max_iterations=100
):
    """
    Universal trial-and-error learning loop
    
    Args:
        trial_function: () -> attempt
        evaluate_function: (attempt) -> score
        improve_function: (attempt, score, history) -> next_attempt
        stop_criteria: (history) -> bool
        
    Returns:
        best_attempt, history
    """
    
    history = []
    current_attempt = trial_function()  # Initial attempt
    
    for iteration in range(max_iterations):
        # Execute trial
        result = execute_trial(current_attempt)
        
        # Evaluate
        score = evaluate_function(result)
        
        # Log
        history.append({
            'iteration': iteration,
            'attempt': current_attempt,
            'result': result,
            'score': score
        })
        
        # Check convergence
        if stop_criteria(history):
            break
        
        # Improve for next iteration
        current_attempt = improve_function(
            current_attempt, 
            score, 
            history
        )
    
    # Return best
    best = max(history, key=lambda h: h['score'])
    return best['attempt'], history

def execute_trial(attempt):
    """Override this with domain-specific execution"""
    return attempt  # Default: identity
```

## Example 1: Parameter Tuning

```python
# Find optimal learning rate
def trial_function():
    return {'learning_rate': random.uniform(1e-5, 1e-2)}

def evaluate_function(result):
    model = train_model(lr=result['learning_rate'])
    return model.validate()

def improve_function(attempt, score, history):
    # Bayesian optimization
    return suggest_next_lr(history)

def stop_criteria(history):
    if len(history) < 10:
        return False
    recent = [h['score'] for h in history[-5:]]
    return np.std(recent) < 0.01  # Converged

best_lr, history = trial_error_loop(
    trial_function,
    evaluate_function, 
    improve_function,
    stop_criteria
)
```

## Example 2: Strategy Optimization

```python
# Optimize trading strategy
def trial_function():
    return generate_random_strategy()

def evaluate_function(result):
    backtest = run_backtest(result)
    return backtest.sharpe_ratio

def improve_function(attempt, score, history):
    # Genetic algorithm
    parent = max(history, key=lambda h: h['score'])['attempt']
    return mutate_strategy(parent)

best_strategy, history = trial_error_loop(...)
```

## Example 3: Prompt Engineering

```python
# Find best prompt
def trial_function():
    return generate_prompt_variant()

def evaluate_function(result):
    response = llm.generate(result)
    return human_rating(response)

def improve_function(attempt, score, history):
    successful_prompts = [h['attempt'] for h in history if h['score'] > 0.8]
    return combine_successful_patterns(successful_prompts)

best_prompt, history = trial_error_loop(...)
```

## Improvement Strategies

```python
# Strategy 1: Random search
def random_improve(attempt, score, history):
    return random_variation(attempt)

# Strategy 2: Gradient descent
def gradient_improve(attempt, score, history):
    gradient = estimate_gradient(history)
    return attempt + learning_rate * gradient

# Strategy 3: Evolutionary
def evolutionary_improve(attempt, score, history):
    population = get_top_k(history, k=10)
    return crossover_mutate(population)

# Strategy 4: Bayesian
def bayesian_improve(attempt, score, history):
    surrogate = fit_surrogate_model(history)
    return acquisition_function(surrogate)
```

## Stop Criteria

```python
# Criterion 1: Score threshold
def threshold_stop(history, target=0.95):
    return any(h['score'] >= target for h in history)

# Criterion 2: Convergence
def convergence_stop(history, window=10, tolerance=0.01):
    if len(history) < window:
        return False
    recent = [h['score'] for h in history[-window:]]
    return np.std(recent) < tolerance

# Criterion 3: No improvement
def plateau_stop(history, patience=20):
    if len(history) < patience:
        return False
    best_score = max(h['score'] for h in history)
    recent_best = max(h['score'] for h in history[-patience:])
    return recent_best < best_score + 0.001

# Criterion 4: Time/iteration limit
def limit_stop(history, max_iter=100, max_time=3600):
    if len(history) >= max_iter:
        return True
    elapsed = time.time() - history[0]['timestamp']
    return elapsed >= max_time
```

---

**FIN SKILL**

Universal trial-error loop - applies to any learning problem.
