---
name: king_skill_wolfram_query
description: Query WolframAlpha for advanced mathematics, physics, chemistry, and scientific computations. Use when sympy/scipy are insufficient.
metadata:
  openclaw:
    emoji: 🔮
    requires:
      bins: ["python3", "pip"]
      env: ["WOLFRAM_APP_ID"]
    install:
      - type: pip
        packages: ["wolframalpha", "requests"]
    os: ["darwin", "linux", "win32"]
    primaryEnv: "WOLFRAM_APP_ID"
---

# Wolfram Query

Query WolframAlpha for advanced mathematics, physics, chemistry, and scientific computations.

## When to Use

**USE this skill when:**
- Advanced mathematics needed
- Closed-form solutions required
- Definite integrals (symbolic)
- Number theory problems
- Prime factorization
- Special functions
- Sympy/scipy insufficient

**DON'T use when:**
- Sympy can solve it (use `king_skill_sympy`)
- Numerical approximation suffices

## Commands

### Setup

```bash
pip install wolframalpha
# Get free API key: https://developer.wolframalpha.com
# Store in env: export WOLFRAM_APP_ID="your_key"
```

### Query Pattern

```python
import wolframalpha
import os

client = wolframalpha.Client(os.environ["WOLFRAM_APP_ID"])

def wolfram_query(query: str) -> str:
    res = client.query(query)
    pods = list(res.pods)
    results = []
    for pod in pods:
        if pod.title in ["Result", "Exact result", "Solution"]:
            results.append(f"{pod.title}: {next(pod.texts)}")
    return "\n".join(results) or str(next(res.results).text)

# Examples:
wolfram_query("integrate sin(x)^2 * cos(x) from 0 to pi")
wolfram_query("eigenvalues of {{4,2},{1,3}}")
wolfram_query("is 982451653 prime")
wolfram_query("Riemann zeta(3) closed form")
```

### Free Alternative

```python
def compute(query_sympy, query_wolfram_fallback):
    try:
        from sympy import *
        return eval(query_sympy)
    except:
        return wolfram_query(query_wolfram_fallback)
```

## Notes

- Requires WolframAlpha API key
- Token savings: 4/5
- Status: ✅ Verified
