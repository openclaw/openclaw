---
name: king_skill_parallel_search
description: Parallelized search, optimization, and exhaustive computation using multiprocessing. For parameter sweeps and embarrassingly parallel workloads.
metadata:
  {
    "openclaw":
      {
        "emoji": "⚡",
        "requires": { "bins": ["python3", "pip"] },
        "install":
          [
            {
              "id": "pip",
              "kind": "pip",
              "packages": ["joblib", "ray"],
              "label": "Install parallel processing libraries (pip)",
            },
          ],
        "os": ["darwin", "linux", "win32"],
      },
  }
---

# Parallel Search

Parallelized search, optimization, and exhaustive computation using multiprocessing.

## When to Use

**USE this skill when:**
- Grid search needed
- Parameter sweeps
- Multiple trials
- Hyperparameter optimization
- Exhaustive search
- Embarrassingly parallel workloads

**DON'T use when:**
- Sequential processing suffices
- Problem is not parallelizable

## Commands

### ProcessPoolExecutor

```python
from concurrent.futures import ProcessPoolExecutor
import numpy as np

def parallel_sweep(fn, param_list, workers=8):
    """Run fn(param) for all params in parallel."""
    with ProcessPoolExecutor(max_workers=workers) as ex:
        results = list(ex.map(fn, param_list))
    return results

# Example: hyperparameter search
def evaluate_config(config):
    score = run_experiment(config)
    return {"config": config, "score": score}

configs = [{"lr": lr, "temp": t}
           for lr in [0.001, 0.01, 0.1]
           for t in [0.5, 1.0, 2.0]]

results = parallel_sweep(evaluate_config, configs, workers=8)
best = max(results, key=lambda r: r["score"])
```

### Joblib

```python
from joblib import Parallel, delayed

results = Parallel(n_jobs=-1)(  # -1 = all cores
    delayed(fn)(param) for param in param_list
)
```

### Simulated Annealing with Restarts

```python
def parallel_sa(objective, n_restarts=100, workers=8):
    seeds = range(n_restarts)
    def sa_run(seed):
        rng = np.random.default_rng(seed)
        state = rng.random(dim)
        # ... simulated annealing ...
        return {"state": state, "energy": objective(state)}

    results = parallel_sweep(sa_run, seeds, workers=workers)
    return min(results, key=lambda r: r["energy"])
```

## Notes

- For large parameter sweeps and SA runs
- Token savings: 5/5
- Status: ✅ Verified
