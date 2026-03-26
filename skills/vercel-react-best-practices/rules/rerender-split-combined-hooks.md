---
title: Split Combined Hook Computations
impact: MEDIUM
impactDescription: avoids recomputing independent steps
tags: rerender, useMemo, useEffect, dependencies, optimization
---

## Split Combined Hook Computations

When a hook contains multiple independent tasks with different dependencies, split them into separate hooks. A combined hook reruns all tasks when any dependency changes, even if some tasks don't use the changed value.

**Incorrect (changing `sortOrder` recomputes filtering):**

```tsx
const sortedProducts = useMemo(() => {
  const filtered = products.filter((p) => p.category === category)
  const sorted = filtered.toSorted((a, b) =>
    sortOrder === "asc" ? a.price - b.price : b.price - a.price
  )
  return sorted
}, [products, category, sortOrder])
```

**Correct (filtering only recomputes when products or category change):**

```tsx
const filteredProducts = useMemo(
  () => products.filter((p) => p.category === category),
  [products, category]
)

const sortedProducts = useMemo(
  () =>
    filteredProducts.toSorted((a, b) =>
      sortOrder === "asc" ? a.price - b.price : b.price - a.price
    ),
  [filteredProducts, sortOrder]
)
```

This pattern also applies to `useEffect` when combining unrelated side effects:

**Incorrect (both effects run when either dependency changes):**

```tsx
useEffect(() => {
  analytics.trackPageView(pathname)
  document.title = `${pageTitle} | My App`
}, [pathname, pageTitle])
```

**Correct (effects run independently):**

```tsx
useEffect(() => {
  analytics.trackPageView(pathname)
}, [pathname])

useEffect(() => {
  document.title = `${pageTitle} | My App`
}, [pageTitle])
```

**Note:** If your project has [React Compiler](https://react.dev/learn/react-compiler) enabled, it automatically optimizes dependency tracking and may handle some of these cases for you.
