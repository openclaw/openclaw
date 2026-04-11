---
name: king_skill_lean4_verify
description: Verify formal proofs and check mathematical claims using Lean 4. Critical for Claims-Boundary Matrix (CBM) verification.
metadata:
  {
    "openclaw":
      {
        "emoji": "✅",
        "requires": { "bins": ["lean", "elan"] },
        "install":
          [
            {
              "id": "elan",
              "kind": "shell",
              "command": "curl -fsSL https://elan.lean-lang.org/elan-init.sh -o /tmp/elan-init.sh && sh /tmp/elan-init.sh -y",
              "label": "Install Lean 4 via elan (safe manual review recommended)",
            },
          ],
        "os": ["darwin", "linux"],
      },
  }
---

# Lean 4 Verification

Verify formal proofs and check mathematical claims using Lean 4.

## When to Use

**USE this skill when:**
- Formal verification of proofs is required
- Checking mathematical claims rigorously
- CBM (Claims-Boundary Matrix) verification
- Theorem proving
- Type-checking mathematical statements

**DON'T use when:**
- Numerical computation suffices (use `king_skill_python_executor`)
- Symbolic manipulation is enough (use `king_skill_sympy`)

## Commands

### Install

```bash
# Safe download-first approach
curl -fsSL https://elan.lean-lang.org/elan-init.sh -o /tmp/elan-init.sh
echo "Review /tmp/elan-init.sh before running"
sh /tmp/elan-init.sh
source ~/.elan/env
elan install leanprover/lean4:stable
```

### Inline Verification

```lean4
-- Save to $TMPDIR/verify.lean then: lean $TMPDIR/verify.lean
import Mathlib.Tactic

-- CBM status markers:
-- ✓ VERIFIED | ⚠ PARTIAL | ✗ PENDING | sorry = FORMAL_PENDING

theorem example_claim (n : ℕ) (h : n > 0) : n * 2 > n := by
  omega

-- For OpenClaw peer review claims:
structure Claim where
  statement  : Prop
  cbm_status : String  -- "VERIFIED" | "PARTIAL" | "PENDING"
  lean4_proof: Option String
```

### CBM Integration

```python
CBM = {
    "VERIFIED":  "∃ Lean4 proof | empirically reproduced",
    "PARTIAL":   "strong evidence, no formal proof",
    "PENDING":   "hypothesis, needs verification",
    "REFUTED":   "∃ counterexample",
}
```

### Quick Check

```bash
# Use environment-aware temp directory
TMP_LEAN=$(mktemp -t verify.XXXXXXXXXX.lean)
echo 'theorem t : 2 + 2 = 4 := by norm_num' > "$TMP_LEAN"
lean "$TMP_LEAN" && echo "VERIFIED" || echo "FAILED"
```

## Notes

- Requires Lean 4 runtime (elan)
- Token savings: 4/5
- Status: ⚠️ Partial (requires manual elan install)
- Test pass rate: 51/53 tests
