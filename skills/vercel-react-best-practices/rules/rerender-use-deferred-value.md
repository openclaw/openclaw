---
title: Use useDeferredValue for Expensive Derived Renders
impact: MEDIUM
impactDescription: keeps input responsive during heavy computation
tags: rerender, useDeferredValue, optimization, concurrent
---

## Use useDeferredValue for Expensive Derived Renders

When user input triggers expensive computations or renders, use `useDeferredValue` to keep the input responsive. The deferred value lags behind, allowing React to prioritize the input update and render the expensive result when idle.

**Incorrect (input feels laggy while filtering):**

```tsx
function Search({ items }: { items: Item[] }) {
  const [query, setQuery] = useState("");
  const filtered = items.filter((item) => fuzzyMatch(item, query));

  return (
    <>
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      <ResultsList results={filtered} />
    </>
  );
}
```

**Correct (input stays snappy, results render when ready):**

```tsx
function Search({ items }: { items: Item[] }) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const filtered = useMemo(
    () => items.filter((item) => fuzzyMatch(item, deferredQuery)),
    [items, deferredQuery],
  );
  const isStale = query !== deferredQuery;

  return (
    <>
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      <div style={{ opacity: isStale ? 0.7 : 1 }}>
        <ResultsList results={filtered} />
      </div>
    </>
  );
}
```

**When to use:**

- Filtering/searching large lists
- Expensive visualizations (charts, graphs) reacting to input
- Any derived state that causes noticeable render delays

**Note:** Wrap the expensive computation in `useMemo` with the deferred value as a dependency, otherwise it still runs on every render.

Reference: [React useDeferredValue](https://react.dev/reference/react/useDeferredValue)
