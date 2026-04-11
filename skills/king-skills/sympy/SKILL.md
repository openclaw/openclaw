---
name: king_skill_sympy
description: Symbolic algebra including differentiation, integration, series expansion, equation solving, matrix algebra, and polynomial manipulation.
metadata:
  openclaw:
    emoji: ∑
    requires:
      bins: ["python3", "pip"]
    install:
      - type: pip
        packages: ["sympy"]
    os: ["darwin", "linux", "win32"]
---

# SymPy Symbolic Math

Symbolic algebra: differentiation, integration, series expansion, equation solving, matrix algebra.

## When to Use

**USE this skill when:**
- Symbolic differentiation/integration
- Series expansion (Taylor, Laurent)
- Equation solving
- Matrix algebra (symbolic)
- Polynomial manipulation
- LaTeX output for papers
- Laplace/Fourier transforms

**DON'T use when:**
- Numerical computation suffices (use `king_skill_python_executor`)
- Formal proof required (use `king_skill_lean4_verify`)

## Commands

```python
from sympy import *

x, y, t, n = symbols('x y t n')
f = symbols('f', cls=Function)

# Differentiation
expr = sin(x**2) * exp(-x)
diff(expr, x)        # first derivative
diff(expr, x, 2)     # second derivative
gradient = [diff(expr, v) for v in [x, y]]

# Integration
integrate(x**2 * exp(-x), (x, 0, oo))   # definite
integrate(sin(x)/x, x)                   # indefinite (Si)

# Series expansion
series(exp(x), x, 0, 6)   # Taylor around 0

# Solve equations
solve(x**2 - 5*x + 6, x)              # [2, 3]
dsolve(f(t).diff(t) + f(t), f(t))     # ODE

# Matrix algebra
M = Matrix([[1, 2], [3, 4]])
M.eigenvals()
M.eigenvects()
M.inv()
M.charpoly()

# LaTeX output (for papers)
latex(integrate(sin(x)**2, x))
# → '-\\frac{\\sin{\\left(x \\right)} \\cos{\\left(x \\right)}}{2} + \\frac{x}{2}'

# Fourier/Laplace transforms
from sympy.integrals.transforms import fourier_transform, laplace_transform
F = fourier_transform(exp(-x**2), x, symbols('k'))
```

## Verification

```python
assert simplify(expr1 - expr2) == 0           # equality check
assert diff(integrate(f, x), x) - f == 0      # fundamental theorem
```

## Notes

- NEVER do symbolic math by hand—delegate to this skill
- Token savings: 4/5
- Status: ✅ Verified
