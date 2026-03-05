# 3D / R3F Notes

Use Three.js directly (default in 3D-template) or React Three Fiber with Remotion.

## Per‑app install (R3F)

```bash
pnpm add three @react-three/fiber @react-three/drei @remotion/three --filter @studio/3d-template
```

## Stability

- Headless rendering: drive animation by Remotion frame (avoid requestAnimationFrame in pipelines).
- WebGL flags: see `apps/3D-template/remotion.config.ts` and pass Chromium flags via CLI if needed.

## Optional composite

`PodcastSlides3D` references an optional alias `@app/remotion3`. It is disabled by default;
enable only if the alias points to a valid app `src/`.
