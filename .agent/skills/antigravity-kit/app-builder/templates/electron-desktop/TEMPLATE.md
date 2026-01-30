---
name: electron-desktop
description: Electron desktop app template principles. Cross-platform, React, TypeScript.
---

# Electron Desktop App Template

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Electron 28+ |
| UI | React 18 |
| Language | TypeScript |
| Styling | Tailwind CSS |
| Bundler | Vite + electron-builder |
| IPC | Type-safe communication |

---

## Directory Structure

```
project-name/
├── electron/
│   ├── main.ts          # Main process
│   ├── preload.ts       # Preload script
│   └── ipc/             # IPC handlers
├── src/
│   ├── App.tsx
│   ├── components/
│   │   ├── TitleBar.tsx # Custom title bar
│   │   └── ...
│   └── hooks/
├── public/
└── package.json
```

---

## Process Model

| Process | Role |
|---------|------|
| Main | Node.js, system access |
| Renderer | Chromium, React UI |
| Preload | Bridge, context isolation |

---

## Key Concepts

| Concept | Purpose |
|---------|---------|
| contextBridge | Safe API exposure |
| ipcMain/ipcRenderer | Process communication |
| nodeIntegration: false | Security |
| contextIsolation: true | Security |

---

## Setup Steps

1. `npm create vite {{name}} -- --template react-ts`
2. Install: `npm install -D electron electron-builder vite-plugin-electron`
3. Create electron/ directory
4. Configure main process
5. `npm run electron:dev`

---

## Build Targets

| Platform | Output |
|----------|--------|
| Windows | NSIS, Portable |
| macOS | DMG, ZIP |
| Linux | AppImage, DEB |

---

## Best Practices

- Use preload script for main/renderer bridge
- Type-safe IPC with typed handlers
- Custom title bar for native feel
- Handle window state (maximize, minimize)
- Auto-updates with electron-updater
