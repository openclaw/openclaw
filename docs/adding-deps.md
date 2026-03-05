# Adding Dependencies

Guidelines for installing packages in this monorepo.

## Per‑app install

Install a dependency only for one app:

```bash
pnpm add <pkg> --filter @studio/<app>
pnpm add -D @types/<pkg> --filter @studio/<app>
```

## Multiple apps

Add it separately to each app that needs it (template stays minimal).

## Shared packages

Not used by default. Create under `packages/` when needed and include in the workspace.

## Peer dependencies (important)

- 2D (Pixi/Konva): `pixi.js`, `konva`
- 3D (R3F): `three`, `@react-three/fiber`, `@react-three/drei`, `@remotion/three`

Install these in the apps that use them.
