---
name: benchmark
description: |
  Performance benchmarking. Baseline page load times, Core Web Vitals, and
  resource sizes. Compare before/after on every PR. Catch bundle size
  regressions before they ship.
---

# Benchmark — Measure Performance

Establish baselines and catch regressions.

**Related skills:** [qa](../qa/SKILL.md) | [review](../review/SKILL.md) | [ship](../ship/SKILL.md)

---

## What to Measure

### Core Web Vitals
- **LCP** (Largest Contentful Paint) — Target: < 2.5s
- **FID** (First Input Delay) — Target: < 100ms
- **CLS** (Cumulative Layout Shift) — Target: < 0.1

### Page Load
- **TTFB** (Time to First Byte)
- **DOMContentLoaded**
- **Load event**
- **Full page load** (all resources)

### Bundle Size
- **JavaScript bundle size** (compressed + uncompressed)
- **CSS bundle size**
- **Total transfer size**
- **Number of requests**

### Resource Analysis
- **Largest assets** by size
- **Uncompressed assets** that should be compressed
- **Unused JavaScript** (tree-shakeable)
- **Image optimization** opportunities

---

## Workflow

### 1. Baseline (before changes)

```bash
git stash  # or checkout base branch
# Run measurements
git stash pop  # or checkout feature branch
```

### 2. Current (after changes)

Run the same measurements on the current branch.

### 3. Compare

```
PERFORMANCE REPORT
═══════════════════════════════════════
                    Before    After     Delta
LCP:                2.1s      2.3s     +200ms ⚠️
CLS:                0.02      0.01     -0.01  ✓
JS Bundle:          245KB     312KB    +67KB  ⚠️
CSS Bundle:         42KB      43KB     +1KB   ✓
Requests:           23        25       +2
Transfer:           890KB     1.1MB    +210KB ⚠️
═══════════════════════════════════════
```

### 4. Flag Regressions

- JS bundle size increase > 10KB → warning
- LCP increase > 200ms → warning
- CLS increase > 0.05 → critical
- New unoptimized images → warning

---

## Important Rules

- Always compare against the base branch, not an absolute value
- Measure multiple times and take the median to reduce noise
- Flag regressions but don't block — some features legitimately increase size
