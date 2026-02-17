# Deployment Platform Reference

## Vercel

**Best for:** Next.js, React, Vue, Svelte, static sites
**CLI:** `npx vercel`
**Config:** `vercel.json`
**Auth:** `VERCEL_TOKEN` or `vercel login`

```bash
# First deploy (interactive)
npx vercel

# Production deploy
npx vercel --prod --yes

# With environment variables
npx vercel --prod --env DATABASE_URL=xxx

# Link to existing project
npx vercel link
npx vercel --prod
```

**Zero-config frameworks:** Next.js, Nuxt, SvelteKit, Astro, Remix, Gatsby, Angular, Vue, Ember.

---

## Netlify

**Best for:** Static sites, JAMstack, Hugo, Jekyll, Astro
**CLI:** `npx netlify-cli`
**Config:** `netlify.toml`
**Auth:** `NETLIFY_AUTH_TOKEN` or `netlify login`

```bash
# Deploy built directory
npx netlify-cli deploy --prod --dir=dist

# Deploy with build
npx netlify-cli deploy --prod --build

# Create new site
npx netlify-cli sites:create --name my-site

# Deploy to draft URL first
npx netlify-cli deploy --dir=dist
```

**netlify.toml example:**

```toml
[build]
  command = "npm run build"
  publish = "dist"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

---

## Cloudflare Pages

**Best for:** Static sites, edge functions, global performance
**CLI:** `npx wrangler`
**Config:** `wrangler.toml`
**Auth:** `CLOUDFLARE_API_TOKEN` or `wrangler login`

```bash
# Deploy static directory
npx wrangler pages deploy dist --project-name=my-site

# Create project first
npx wrangler pages project create my-site

# Deploy with branch (preview)
npx wrangler pages deploy dist --project-name=my-site --branch=staging
```

---

## GitHub Pages

**Best for:** Documentation, personal sites, project pages (free)
**CLI:** `npx gh-pages` or GitHub Actions
**Config:** GitHub Actions workflow
**Auth:** GitHub token (via `gh` CLI)

```bash
# Deploy via gh-pages package
npx gh-pages -d dist

# Deploy via GitHub Actions (see setup-gh-pages.sh)
```

**URL pattern:**

- User site: `https://<user>.github.io/`
- Project site: `https://<user>.github.io/<repo>/`

---

## Fly.io

**Best for:** Full-stack apps, Docker containers, databases, backend APIs
**CLI:** `flyctl`
**Config:** `fly.toml`
**Auth:** `FLY_API_TOKEN` or `flyctl auth login`

```bash
# First time setup
flyctl launch

# Deploy
flyctl deploy

# Scale
flyctl scale count 2
flyctl scale vm shared-cpu-1x

# Set secrets
flyctl secrets set DATABASE_URL=xxx
```

**fly.toml example:**

```toml
app = "my-app"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 3000
  force_https = true

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
```

---

## Railway

**Best for:** Quick deploys, databases, full-stack apps
**CLI:** `railway`
**Config:** `railway.toml`
**Auth:** `RAILWAY_TOKEN` or `railway login`

```bash
# Deploy
railway up

# Link to project
railway link

# Add database
railway add --plugin postgresql
```

## Platform Comparison

| Feature              | Vercel   | Netlify | Cloudflare    | GH Pages | Fly.io     | Railway  |
| -------------------- | -------- | ------- | ------------- | -------- | ---------- | -------- |
| Free tier            | Yes      | Yes     | Yes           | Yes      | Yes        | Yes      |
| Custom domain        | Yes      | Yes     | Yes           | Yes      | Yes        | Yes      |
| HTTPS                | Auto     | Auto    | Auto          | Auto     | Auto       | Auto     |
| Serverless functions | Yes      | Yes     | Yes (Workers) | No       | N/A        | N/A      |
| Docker               | No       | No      | No            | No       | Yes        | Yes      |
| Database             | Postgres | No      | D1/KV         | No       | Postgres   | Postgres |
| Build minutes (free) | 6000/mo  | 300/mo  | 500/mo        | 2000/mo  | N/A        | 500/mo   |
| Bandwidth (free)     | 100GB    | 100GB   | Unlimited     | 100GB    | 3GB shared | 100GB    |
