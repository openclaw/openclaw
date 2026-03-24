---
name: exploration-exploitation-balancer
description: Balance exploration (trying new things) vs exploitation (using what works). Use for "explore vs exploit", "balance novelty vs optimization", "epsilon-greedy", "multi-armed bandit", or any decision requiring exploration/exploitation tradeoff. Universal pattern for search and optimization.
---

# EXPLORATION-EXPLOITATION BALANCER

Universal balance between trying new things vs using what works.

## Core Pattern

```python
def should_explore(
    iteration,
    total_iterations,
    strategy='epsilon_greedy',  # epsilon_greedy, ucb, thompson, decay
    epsilon=0.1,
    **params
):
    """
    Decide: explore (try new) or exploit (use best)?
    
    Returns:
        bool (True = explore, False = exploit)
    """
    
    if strategy == 'epsilon_greedy':
        return random.random() < epsilon
    
    elif strategy == 'epsilon_decay':
        current_epsilon = epsilon * (1 - iteration / total_iterations)
        return random.random() < current_epsilon
    
    elif strategy == 'ucb':
        return select_ucb(params['history'], iteration)
    
    elif strategy == 'thompson':
        return sample_thompson(params['beliefs'])

def epsilon_greedy_select(options, scores, epsilon=0.1):
    """
    Select action: explore random or exploit best
    
    Args:
        options: List of available choices
        scores: Current score for each option
        epsilon: Exploration probability
        
    Returns:
        selected_option
    """
    
    if random.random() < epsilon:
        # Explore: random choice
        return random.choice(options)
    else:
        # Exploit: best known
        best_idx = np.argmax(scores)
        return options[best_idx]

def ucb_select(options, scores, counts, c=2):
    """
    Upper Confidence Bound selection
    
    Balances exploitation (high score) with exploration (low count)
    """
    
    total_count = sum(counts)
    ucb_scores = []
    
    for i in range(len(options)):
        if counts[i] == 0:
            ucb_scores.append(float('inf'))  # Try unexplored first
        else:
            exploitation = scores[i]
            exploration = c * np.sqrt(np.log(total_count) / counts[i])
            ucb_scores.append(exploitation + exploration)
    
    best_idx = np.argmax(ucb_scores)
    return options[best_idx]

def adaptive_epsilon(iteration, performance_history, base_epsilon=0.1):
    """
    Adjust exploration based on performance
    
    If stuck → explore more
    If improving → explore less
    """
    
    if len(performance_history) < 10:
        return base_epsilon
    
    recent = performance_history[-10:]
    improvement = recent[-1] - recent[0]
    
    if improvement < 0.01:
        # Stuck → explore more
        return min(base_epsilon * 2, 0.5)
    else:
        # Improving → exploit more
        return max(base_epsilon * 0.5, 0.01)
```

## Example: Hyperparameter Search

```python
# Exploration phase: try random configs
# Exploitation phase: refine best config

params_tried = []
scores = []

for iteration in range(100):
    if should_explore(iteration, 100, strategy='epsilon_decay', epsilon=0.3):
        # Explore: random parameters
        params = random_parameters()
    else:
        # Exploit: refine best
        best_params = params_tried[np.argmax(scores)]
        params = refine_parameters(best_params)
    
    score = evaluate(params)
    params_tried.append(params)
    scores.append(score)
```

---

**FIN SKILL**
