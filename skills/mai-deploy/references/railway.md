# Railway Deployment Guide

**Target projects:** MAIOSS, MAIBEAUTY, MAISTAR7

## Initial Setup (one-time)

```powershell
cd C:\TEST\MAI{project}
railway login
railway init
railway link
```

## Environment Variables

```powershell
railway variables set DATABASE_URL="..." API_KEY="..."
```

## Deploy

```powershell
railway up
```

## Status & Logs

```powershell
railway status
railway logs
```

## Pre-Deploy Checklist

- [ ] `pnpm build` succeeds
- [ ] `pnpm test` passes
- [ ] Environment variables set (`deploy.json` → `env_required`)
- [ ] `railway.json` or `Procfile` exists

## Rollback

```powershell
railway rollback
```
