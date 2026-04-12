---
name: parameter-optimizer
description: Automatically optimize parameters. Use for "optimise paramètres", "tune hyperparameters", "find best config", "auto-calibration", or any workflow requiring parameter optimization. Universal optimization across grid search, random search, Bayesian optimization.
---

# PARAMETER OPTIMIZER

Universal automatic parameter optimization.

## Core Pattern

```python
def optimize_parameters(
    parameter_space,
    objective_function,
    method='bayesian',  # grid, random, bayesian, genetic
    n_iterations=50,
    n_initial=10
):
    """
    Find optimal parameters automatically
    
    Args:
        parameter_space: Dict of {param: (min, max)} or [values]
        objective_function: (params) -> score
        method: Optimization strategy
        n_iterations: How many trials
        
    Returns:
        best_params, history
    """
    
    if method == 'grid':
        return grid_search(parameter_space, objective_function)
    
    elif method == 'random':
        return random_search(parameter_space, objective_function, n_iterations)
    
    elif method == 'bayesian':
        return bayesian_optimization(parameter_space, objective_function, n_iterations, n_initial)
    
    elif method == 'genetic':
        return genetic_algorithm(parameter_space, objective_function, n_iterations)

def random_search(space, objective, n_iterations):
    """Try random combinations"""
    history = []
    
    for i in range(n_iterations):
        # Sample random parameters
        params = {
            key: random.uniform(bounds[0], bounds[1]) if isinstance(bounds, tuple)
                 else random.choice(bounds)
            for key, bounds in space.items()
        }
        
        # Evaluate
        score = objective(params)
        history.append({'params': params, 'score': score})
    
    best = max(history, key=lambda h: h['score'])
    return best['params'], history

def bayesian_optimization(space, objective, n_iterations, n_initial):
    """Smart search using surrogate model"""
    from sklearn.gaussian_process import GaussianProcessRegressor
    
    # Initial random samples
    history = random_search(space, objective, n_initial)[1]
    
    for i in range(n_iterations - n_initial):
        # Fit surrogate model
        X = np.array([list(h['params'].values()) for h in history])
        y = np.array([h['score'] for h in history])
        
        gp = GaussianProcessRegressor()
        gp.fit(X, y)
        
        # Acquisition function: expected improvement
        next_params = maximize_expected_improvement(gp, space)
        
        # Evaluate
        score = objective(next_params)
        history.append({'params': next_params, 'score': score})
    
    best = max(history, key=lambda h: h['score'])
    return best['params'], history

def grid_search(space, objective):
    """Exhaustive search (small spaces only)"""
    import itertools
    
    # Generate all combinations
    keys = list(space.keys())
    values = [space[k] if isinstance(space[k], list) 
              else np.linspace(space[k][0], space[k][1], 10)
              for k in keys]
    
    history = []
    
    for combo in itertools.product(*values):
        params = dict(zip(keys, combo))
        score = objective(params)
        history.append({'params': params, 'score': score})
    
    best = max(history, key=lambda h: h['score'])
    return best['params'], history

def genetic_algorithm(space, objective, n_iterations, population_size=20):
    """Evolutionary optimization"""
    
    # Initialize population
    population = [random_params(space) for _ in range(population_size)]
    history = []
    
    for generation in range(n_iterations):
        # Evaluate fitness
        scores = [objective(p) for p in population]
        
        # Log
        for p, s in zip(population, scores):
            history.append({'params': p, 'score': s})
        
        # Selection (top 50%)
        sorted_pop = sorted(zip(population, scores), key=lambda x: x[1], reverse=True)
        survivors = [p for p, s in sorted_pop[:population_size//2]]
        
        # Crossover + mutation
        offspring = []
        while len(offspring) < population_size - len(survivors):
            parent1, parent2 = random.sample(survivors, 2)
            child = crossover(parent1, parent2)
            child = mutate(child, space)
            offspring.append(child)
        
        population = survivors + offspring
    
    best = max(history, key=lambda h: h['score'])
    return best['params'], history
```

## Example: Optimize ML Hyperparameters

```python
# Define search space
space = {
    'learning_rate': (1e-5, 1e-2),
    'batch_size': [16, 32, 64, 128],
    'dropout': (0.0, 0.5)
}

# Objective: validation accuracy
def objective(params):
    model = train_model(**params)
    return model.validate()

# Optimize
best_params, history = optimize_parameters(
    space,
    objective,
    method='bayesian',
    n_iterations=50
)

print(f"Best params: {best_params}")
print(f"Best score: {max(h['score'] for h in history)}")
```

---

**FIN SKILL**

**🎉 8 SKILLS UNIVERSELS CRÉÉS! 🎉**
