# Static Site Deployment (GitHub Pages / Vercel)

**Target:** MAIOSS docs, MAICON docs

## GitHub Pages

```powershell
cd C:\TEST\MAI{project}
pnpm build:docs
gh-pages -d docs/.vitepress/dist
```

## Vercel

```powershell
vercel --prod
```

## Pre-Deploy Checklist

- [ ] Docs build succeeds
- [ ] No broken links
- [ ] `vercel.json` or GitHub Pages config complete
