# OpenClaw Windows app

## Build / Run

```bash
cd apps/windows
npm install
npm run tauri dev
```

## Build installers:

```bash
cd apps/windows
npm run tauri build
```

## Bundle targets

Configured in `src-tauri/tauri.conf.json`:

- NSIS
- MSI
