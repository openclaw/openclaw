---
title: React 19 API Changes
impact: MEDIUM
impactDescription: cleaner component definitions and context usage
tags: react19, refs, context, hooks
---

## React 19 API Changes

> **⚠️ React 19+ only.** Skip this if you're on React 18 or earlier.

In React 19, `ref` is now a regular prop (no `forwardRef` wrapper needed). Additionally, `use()` can read context (as an alternative to `useContext()`), but `useContext()` remains fully supported.

**Incorrect (forwardRef in React 19):**

```tsx
const ComposerInput = forwardRef<TextInput, Props>((props, ref) => {
  return <TextInput ref={ref} {...props} />;
});
```

**Correct (ref as a regular prop):**

```tsx
function ComposerInput({ ref, ...props }: Props & { ref?: React.Ref<TextInput> }) {
  return <TextInput ref={ref} {...props} />;
}
```

**Traditional (still valid in React 19):**

```tsx
const value = useContext(MyContext);
```

**Alternative (React 19 `use()` — can be called conditionally):**

```tsx
const value = use(MyContext);
```

Both `useContext()` and `use()` are fully supported in React 19. Prefer `use()` when you need conditional context reads; otherwise either works.
