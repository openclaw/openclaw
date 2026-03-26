---
title: Don't Define Components Inside Components
impact: HIGH
impactDescription: prevents remount on every render
tags: rerender, components, remount, performance
---

## Don't Define Components Inside Components

**Impact: HIGH (prevents remount on every render)**

Defining a component inside another component creates a new component type on every render. React sees a different component each time and fully remounts it, destroying all state and DOM.

A common reason developers do this is to access parent variables without passing props. Always pass props instead.

**Incorrect (remounts on every render):**

```tsx
function UserProfile({ user, theme }) {
  // Defined inside to access `theme` - BAD
  const Avatar = () => (
    <img src={user.avatarUrl} className={theme === "dark" ? "avatar-dark" : "avatar-light"} />
  );

  // Defined inside to access `user` - BAD
  const Stats = () => (
    <div>
      <span>{user.followers} followers</span>
      <span>{user.posts} posts</span>
    </div>
  );

  return (
    <div>
      <Avatar />
      <Stats />
    </div>
  );
}
```

Every time `UserProfile` renders, `Avatar` and `Stats` are new component types. React unmounts the old instances and mounts new ones, losing any internal state, running effects again, and recreating DOM nodes.

**Correct (pass props instead):**

```tsx
function Avatar({ src, theme }: { src: string; theme: string }) {
  return <img src={src} className={theme === "dark" ? "avatar-dark" : "avatar-light"} />;
}

function Stats({ followers, posts }: { followers: number; posts: number }) {
  return (
    <div>
      <span>{followers} followers</span>
      <span>{posts} posts</span>
    </div>
  );
}

function UserProfile({ user, theme }) {
  return (
    <div>
      <Avatar src={user.avatarUrl} theme={theme} />
      <Stats followers={user.followers} posts={user.posts} />
    </div>
  );
}
```

**Symptoms of this bug:**

- Input fields lose focus on every keystroke
- Animations restart unexpectedly
- `useEffect` cleanup/setup runs on every parent render
- Scroll position resets inside the component
