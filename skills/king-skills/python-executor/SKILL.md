---
name: king_skill_python_executor
description: Execute deterministic numerical, statistical, algebraic, or signal-processing computations via Python. Use instead of reasoning through math manually.
metadata:
  openclaw:
    emoji: 🧮
    requires:
      bins: ["python3", "pip"]
    install:
      - type: apt
        packages: ["python3", "python3-pip"]
      - type: pip
        packages: ["numpy", "scipy", "sympy", "matplotlib"]
    os: ["darwin", "linux", "win32"]
---

# Python Executor

Execute any deterministic numerical, statistical, algebraic or signal-processing computation via Python.

## When to Use

**USE this skill when:**
- Calculating eigenvalues, eigenvectors, matrix operations
- Computing integrals (numerical or symbolic)
- Performing FFT, signal processing
- Optimization and curve fitting
- Solving ODEs
- Statistical analysis

**DON'T use when:**
- Symbolic math is explicitly needed (use `king_skill_sympy` instead)
- The problem requires formal proof (use `king_skill_lean4_verify`)

## Commands

```python
import numpy as np
from scipy.integrate import quad, solve_ivp
from scipy.linalg import eig, inv, det
from scipy.optimize import minimize, curve_fit
from scipy import signal
import sympy as sp
from sympy import symbols, integrate, diff, solve, Matrix, exp, sin, oo, latex
```

### Eigenvalues

```python
A = np.array([[4, 2], [1, 3]])
evals = np.linalg.eigvals(A)  # → [2. 5.]
```

### Definite Integral

```python
result, err = quad(lambda x: np.sin(x)**2, 0, np.pi)  # → 1.5707... = π/2
```

### Optimization

```python
res = minimize(lambda x: (x[0]-1)**2 + (x[1]-2)**2, [0, 0])  # → [1, 2]
```

### FFT - Find Dominant Frequency

```python
t = np.linspace(0, 1, 1000)
sig = np.sin(2*np.pi*50*t)
freqs = np.fft.fftfreq(len(t), t[1]-t[0])
peak_freq = abs(freqs[np.argmax(np.abs(np.fft.fft(sig))[:500])])  # → 50 Hz
```

### Symbolic Integration

```python
x = sp.Symbol('x')
sp.integrate(x**2 * sp.exp(-x), (x, 0, sp.oo))  # → 2
```

### ODE Solve

```python
sol = solve_ivp(lambda t, y: [-y[0]], [0, 10], [1.0], method='RK45', rtol=1e-8)
```

## Verification

```python
assert np.allclose(result, expected, rtol=1e-6)
assert sol.success
```

## Notes

- Verified with Python 3.12, numpy, scipy, sympy
- Token savings: ★★★★★
- Status: ✅ Verified
