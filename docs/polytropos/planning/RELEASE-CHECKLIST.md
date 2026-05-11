# Polytropos Core Release Checklist

This checklist produces a versioned release directory under `~/polytropos/releases/<tag>/`.

**Release definition:** for OpenClaw/Polytropos core, a release is a **byte-for-byte copy of a `dist/` directory** (see [`docs/polytropos/CORE-RELEASES.md`](../CORE-RELEASES.md)).

## Inputs

- Core repo: `openclaw-polytropos`
- Version tag: `<tag>` (example: `polytropos-core/v2026.05.10`)

## 0) Prereqs

- `~/polytropos/` exists
- gateway is healthy before starting:
  - `openclaw gateway status`
  - `openclaw doctor --non-interactive`

## 1) Build (produce dist/)

Build is the act of producing `<repo>/dist/` from a specific core tag.

Canonical build sequence (deterministic):

```bash
pnpm install
pnpm ui:build
pnpm build
```

Output: `<repo>/dist/`.

## 2) Release (create the release directory)

Release is the act of copying the built `dist/` into a versioned runnable directory:

1) Create versioned release directory:

   - `mkdir -p ~/polytropos/releases/<tag>`

2) Copy dist byte-for-byte:

   - `cp -a <repo>/dist/. ~/polytropos/releases/<tag>/`

3) Sanity check:

   - `test -f ~/polytropos/releases/<tag>/index.js`

## 2) Initialize symlinks (current/previous/dev)

1) Set `previous` to the baseline release:

   - `ln -sfn ~/polytropos/releases/<tag> ~/polytropos/releases/previous`

2) Set `current` to the baseline release (no behavior change yet):

   - `ln -sfn ~/polytropos/releases/<tag> ~/polytropos/releases/current`

3) Set `dev` to the core repo build output (for later; optional now):

   - `ln -sfn ~/polytropos/openclaw-polytropos/dist ~/polytropos/releases/dev`

## 3) Cutover (when ready)

Do **not** cutover during release creation unless explicitly intended.

When ready, follow:

- [`docs/polytropos/planning/CUTOVER-EXECSTART.md`](./CUTOVER-EXECSTART.md)

## 4) Post-cutover verification (after you switch ExecStart)

- `openclaw gateway status`
- `openclaw doctor --non-interactive`
- confirm PID is stable and logs look normal

## 5) Moving from baseline to fork-built releases (later)

Once we are ready to run the fork:

1) Create a versioned tag in `openclaw-polytropos`
2) Build the repo to produce `dist/`
3) Copy that `dist/` into `~/polytropos/releases/<tag>/`
4) Flip `current` → `<tag>` and restart

---

## Notes

- Keeping `previous` updated is what makes rollback via symlink flip actually work.
- Plugins remain in `~/.openclaw/extensions/*` and are not moved as part of core releases.
