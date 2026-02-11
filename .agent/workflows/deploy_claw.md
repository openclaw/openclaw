---
description: Deploy and validate OpenClaw on a server
---

# Deploy OpenClaw

This workflow guides you through deploying OpenClaw and validating the installation.

## 1. Prepare Environment

Ensure you are in the project root.

```bash
cd /Users/lizhihong/claw
```

## 2. Run Setup

Run the docker setup script to build and start the services.

```bash
./docker-setup.sh
```

## 3. Validate Deployment

Run the validation script to ensure everything is healthy.

```bash
// turbo
./scripts/deploy-validation.sh
```

## 4. Check Logs (Optional)

If validation fails, check the logs.

```bash
docker compose logs --tail 20 openclaw-gateway
```
