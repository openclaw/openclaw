---
name: iterative-refinement
description: Incrementally improve solution through iterations. Use for "amélioration itérative", "incremental improvement", "successive refinement", "polish solution", or any workflow requiring gradual optimization. Universal pattern for refinement processes.
---

# ITERATIVE REFINEMENT

Universal incremental improvement pattern.

## Core Pattern

```python
def iterative_refinement(
    initial_solution,
    refine_function,
    evaluate_function,
    max_iterations=10,
    improvement_threshold=0.01
):
    """
    Incrementally improve solution
    
    Args:
        initial_solution: Starting point
        refine_function: (solution) -> improved_solution
        evaluate_function: (solution) -> score
        max_iterations: Stop after this many iterations
        improvement_threshold: Stop if improvement < this
        
    Returns:
        refined_solution, history
    """
    
    current = initial_solution
    current_score = evaluate_function(current)
    
    history = [{
        'iteration': 0,
        'solution': current,
        'score': current_score
    }]
    
    for i in range(1, max_iterations + 1):
        # Refine
        refined = refine_function(current)
        refined_score = evaluate_function(refined)
        
        # Track
        history.append({
            'iteration': i,
            'solution': refined,
            'score': refined_score
        })
        
        # Check improvement
        improvement = refined_score - current_score
        
        if improvement < improvement_threshold:
            break  # Converged
        
        # Accept improvement
        current = refined
        current_score = refined_score
    
    return current, history

# Refinement strategies

def gradient_refine(solution, gradient_fn, learning_rate=0.1):
    """Small step in gradient direction"""
    gradient = gradient_fn(solution)
    return solution - learning_rate * gradient

def local_search_refine(solution, neighbors_fn):
    """Try nearby solutions, keep best"""
    neighbors = neighbors_fn(solution)
    return max(neighbors, key=evaluate_function)

def simulated_annealing_refine(solution, neighbors_fn, temperature):
    """Probabilistic local search"""
    neighbor = random.choice(neighbors_fn(solution))
    delta = evaluate_function(neighbor) - evaluate_function(solution)
    
    if delta > 0 or random.random() < np.exp(delta / temperature):
        return neighbor
    return solution

def ensemble_refine(solution, refine_functions):
    """Apply multiple refinement strategies"""
    candidates = [fn(solution) for fn in refine_functions]
    return max(candidates, key=evaluate_function)
```

## Example: Prompt Refinement

```python
initial_prompt = "Summarize this text"

def refine_prompt(prompt):
    # Add specificity
    improvements = [
        f"{prompt} in 3 sentences",
        f"{prompt} focusing on key points",
        f"Please {prompt.lower()} concisely"
    ]
    return max(improvements, key=lambda p: evaluate_function(p))

def evaluate_prompt(prompt):
    response = llm.generate(prompt)
    return human_rating(response)

best_prompt, history = iterative_refinement(
    initial_prompt,
    refine_prompt,
    evaluate_prompt,
    max_iterations=5
)
```

---

**FIN SKILL**
