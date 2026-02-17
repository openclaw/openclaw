---
name: site-deployer
description: Deploy websites and web apps automatically to hosting platforms (Vercel, Netlify, Cloudflare Pages, GitHub Pages, Fly.io, Railway). Use when the user wants to deploy a site, push to production, set up hosting, or launch a web project. Also triggers for "deploy this", "put this online", "host this website", or "ship it".
metadata: { "openclaw": { "emoji": "🚀", "requires": { "anyBins": ["npx", "git", "curl"] } } }
---

# Site Deployer

Deploy websites and web apps to hosting platforms automatically.

## Supported Platforms

| Platform             | CLI               | Detection            | Zero-config |
| -------------------- | ----------------- | -------------------- | ----------- |
| **Vercel**           | `npx vercel`      | `vercel.json`        | Yes         |
| **Netlify**          | `npx netlify-cli` | `netlify.toml`       | Yes         |
| **Cloudflare Pages** | `npx wrangler`    | `wrangler.toml`      | Yes         |
| **GitHub Pages**     | `gh-pages` / git  | `.github/workflows/` | Yes         |
| **Fly.io**           | `flyctl`          | `fly.toml`           | No          |
| **Railway**          | `railway`         | `railway.toml`       | Yes         |

## Workflow

### 1. Detect or choose platform

```bash
# Check for existing platform configs
ls vercel.json netlify.toml wrangler.toml fly.toml railway.toml 2>/dev/null

# Check for framework to auto-detect best platform
ls package.json next.config.* nuxt.config.* vite.config.* astro.config.* 2>/dev/null
```

**Auto-selection heuristic:**

- Next.js / React → Vercel (best DX)
- Static HTML / Astro / Hugo → Netlify or Cloudflare Pages
- Docker / backend → Fly.io or Railway
- Simple static → GitHub Pages (free, zero-config)

### 2. Build the project

```bash
# Detect and run the build command
npm run build    # or pnpm build, yarn build
# Output dir: dist/, build/, out/, .next/, public/
```

### 3. Deploy

**Vercel (recommended for Next.js):**

```bash
npx vercel --yes --prod
# or link first: npx vercel link && npx vercel --prod
```

**Netlify:**

```bash
npx netlify-cli deploy --prod --dir=dist
# or with build: npx netlify-cli deploy --prod --build
```

**Cloudflare Pages:**

```bash
npx wrangler pages deploy dist --project-name=my-site
```

**GitHub Pages:**

```bash
# Via gh-pages package
npx gh-pages -d dist

# Or via GitHub Actions (create workflow if missing)
scripts/setup-gh-pages.sh
git push
```

**Fly.io:**

```bash
# Requires fly.toml - create if missing
flyctl launch --no-deploy  # first time
flyctl deploy               # subsequent
```

**Railway:**

```bash
railway up
```

### 4. Verify deployment

```bash
# Get the deployment URL from CLI output
# Then verify it's live:
curl -sI <deployment-url> | head -5
```

## Scripts

- `scripts/deploy.sh` - Universal deploy script with auto-detection
- `scripts/setup-gh-pages.sh` - Generate GitHub Pages workflow + configure repo

For detailed platform-specific reference, see [references/platforms.md](references/platforms.md).

### Universal Deploy Script

```bash
# Auto-detect platform and deploy
scripts/deploy.sh auto

# Deploy to specific platform
scripts/deploy.sh vercel
scripts/deploy.sh netlify --dir dist
scripts/deploy.sh cloudflare --dir dist --project my-site
scripts/deploy.sh gh-pages --dir dist
scripts/deploy.sh fly
scripts/deploy.sh railway

# Staging/preview deploy
scripts/deploy.sh vercel --staging
```

## Environment Variables

| Variable               | Platform         | Purpose               |
| ---------------------- | ---------------- | --------------------- |
| `VERCEL_TOKEN`         | Vercel           | Deploy token          |
| `NETLIFY_AUTH_TOKEN`   | Netlify          | Personal access token |
| `CLOUDFLARE_API_TOKEN` | Cloudflare Pages | API token             |
| `FLY_API_TOKEN`        | Fly.io           | Auth token            |
| `RAILWAY_TOKEN`        | Railway          | Project token         |

## Tips

- Use `--prod` flag for production deployments (staging is default on most platforms)
- All platforms support preview deployments on PRs automatically
- For static sites without a framework, just point to the directory containing index.html
- When user says "deploy this" without specifying a platform, auto-detect or default to Vercel
- Always show the deployment URL after successful deploy
- If no build step exists, deploy the current directory as static files
