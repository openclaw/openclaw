---
name: king_skill_sat_solver
description: Solve Boolean satisfiability, constraint satisfaction, graph coloring, scheduling, and combinatorial optimization problems via SAT/SMT solvers.
metadata:
  {
    "openclaw":
      {
        "emoji": "🎯",
        "requires": { "bins": ["python3", "pip"] },
        "install":
          [
            {
              "id": "pip",
              "kind": "pip",
              "packages": ["python-sat", "z3-solver", "ortools"],
              "label": "Install SAT/SMT solvers (pip)",
            },
          ],
        "os": ["darwin", "linux", "win32"],
      },
  }
---

# SAT Solver

Solve Boolean satisfiability, constraint satisfaction, graph coloring, scheduling, and combinatorial optimization problems.

## When to Use

**USE this skill when:**
- SAT/SMT problems
- Graph coloring
- Constraint satisfaction (CSP)
- Combinatorial optimization
- Ramsey numbers
- Scheduling problems
- Assignment problems
- Clique finding

**DON'T use when:**
- Problem can be solved analytically (use `king_skill_sympy`)
- Requires numerical simulation (use `king_skill_scipy_sim`)

## Commands

### Install

```bash
pip install python-sat z3-solver
pip install ortools  # for scheduling
```

### PySAT (CaDiCaL)

```python
from pysat.solvers import Cadical153
from pysat.formula import CNF

formula = CNF()
formula.append([1, 2])       # x1 OR x2
formula.append([-1, 3])      # NOT x1 OR x3

with Cadical153(bootstrap_with=formula) as solver:
    sat = solver.solve()
    model = solver.get_model() if sat else None
print(f"SAT: {sat}, model: {model}")
```

### Z3 (SMT)

```python
from z3 import *
x, y = Ints('x y')
s = Solver()
s.add(x + y == 10, x > 0, y > 0, x != y)
result = s.check()
if result == sat:
    m = s.model()
    print(f"x={m[x]}, y={m[y]}")
```

### Graph Coloring (k-colorability)

```python
def k_colorable(G: dict, k: int) -> dict | None:
    """G = {node: [neighbors]}. Returns coloring dict or None."""
    from pysat.solvers import Cadical153
    nodes = list(G.keys())
    n = len(nodes)
    var = lambda i, c: i * k + c + 1
    clauses = []
    for i in range(n):
        clauses.append([var(i, c) for c in range(k)])
        for c1 in range(k):
            for c2 in range(c1+1, k):
                clauses.append([-var(i,c1), -var(i,c2)])
    for i, nbrs in enumerate(G.values()):
        for j in [nodes.index(nb) for nb in nbrs if nb > nodes[i]]:
            for c in range(k):
                clauses.append([-var(i,c), -var(j,c)])
    with Cadical153(bootstrap_with=clauses) as s:
        if s.solve():
            m = s.get_model()
            return {nodes[i]: next(c for c in range(k) if m[var(i,c)-1]>0)
                    for i in range(n)}
    return None
```

## Verification

```python
# Verify coloring
assert all(coloring[u] != coloring[v] for u, nbrs in G.items() for v in nbrs)
```

## Notes

- Token savings: ★★★★★
- Status: ✅ Verified
- Dependencies: python-sat, z3-solver, ortools
