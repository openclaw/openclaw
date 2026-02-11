---
description: Deploy/Run OpenClaw locally from source
---

# Run OpenClaw Locally (from source)

Use this workflow to run OpenClaw directly on your machine without Docker.

## 1. Install Dependencies

Ensure you have Node.js (>=22) and pnpm enabled.

```bash
corepack enable
pnpm install
```

## 2. Build

Build the project (includes UI and Gateway).

```bash
pnpm build
```

## 3. Onboard

Run the onboarding wizard to configure your assistant.

```bash
pnpm openclaw onboard
```

## 4. Maintenance / Updates

To update to the latest version:

```bash
git pull
pnpm install
pnpm build
```
