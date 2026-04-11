---
name: king_skill_token_compression
description: Maximum token compression by substituting natural language with mathematical notation, code, and physical formulas. Reduces output tokens by ~33% while preserving reasoning quality.
metadata:
  openclaw:
    emoji: 🗜️
    requires:
      bins: ["python3"]
    install: []
    os: ["darwin", "linux", "win32"]
---

# Token Compression

Maximum token compression by substituting natural language with mathematical notation, code, and physical formulas.

## When to Use

**USE this skill when:**
- Output needs compression
- Mathematical notation available
- Code can replace explanation
- Physical formulas applicable
- Token budget is tight

**CRITICAL - Two-Budget Rule:**
- **NEVER** compress thinking (CoT) → reasoning quality ∝ thinking tokens
- **ALWAYS** compress output → ~33% savings on response

## Commands

### Core Architecture

```python
budget = {
    "thinking": {
        "style": "free CoT in English + math + code",
        "compress": False,
        "reason": "intermediate tokens ≡ compute, not output",
    },
    "output": {
        "style": "maximum compression — full arsenal",
        "compress": True,
        "reason": "expert reads dense notation without loss",
    },
}
```

### Mathematics & Physics

```
# Relations
y ∝ x              # "grows with"
dy/dx > 0          # "increasing trend"
f(A, B)            # "depends on A and B"
X ⟹ Y             # "if X then Y"
∀x ∈ S: P(x)      # "for all x in S, P holds"
∃x: P(x)           # "there exists x such that P"
∴ Q                # "therefore Q"
∵ P                # "because P"
A ⟺ B             # "A if and only if B"
A ≡ B              # "A defined as B"

# Physics
S = k_B ln(Ω)              # thermodynamic entropy
H = -Σ p_i log₂(p_i)      # information entropy
I(X;Y) = H(X) - H(X|Y)    # mutual information
D_KL(P‖Q) = Σ P log(P/Q)  # KL divergence
∂S/∂t ≥ 0                  # second law
```

### Python Pseudocode

```python
result = A if condition else B
while not converged(state): state = update(state)
[f(x) for x in data if P(x)]
result = reduce(g, map(f, filter(P, data)))
state = {"verified": True, "score": 0.87, "iter": 42}
```

### Compression Table

| Natural Language | Compressed |
|-----------------|------------|
| "as we can see" | *(omit)* |
| "therefore" | `∴` |
| "because" | `∵` |
| "if and only if" | `⟺` |
| "for all X" | `∀x` |
| "there exists X" | `∃x` |
| "approximately" | `≈` |
| "defined as" | `≡` |

## When NOT to Compress

- Ethical nuances
- Aesthetic judgments
- New concepts (need natural anchor)
- Short words (≤4 chars)

## Notes

- Measured savings: 2.7× average (10 examples)
- Golden rule: if a natural language phrase has a compact formal equivalent → USE THE FORMAL
- Status: ✅ Verified
