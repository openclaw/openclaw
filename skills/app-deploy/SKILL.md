---
name: app-deploy
description: "Deploy a clawy user app from scaffold to live URL. Use when: (1) scaffolding a new app with `clawy app create`, (2) setting up the database schema, systemd service, Caddy route, and dashboard tile for an app, (3) running the full deploy pipeline after building app code, (4) verifying a deployed app is accessible and passing tests. NOT for: debugging broken apps (use app-debug), writing tests (use app-test), removing apps (use app-destroy), or database migrations (use db-migrate)."
---

# App Deploy

Deploy a clawy app from scaffold to live, accessible URL. Each step is mandatory — skipping any step leaves the app broken or inaccessible.

## Pipeline (all steps required)

### 1. Scaffold

```bash
clawy app create <app-name>
```

Creates: Express server, PostgreSQL database, Caddy route with auth, systemd service, Jest + Puppeteer test scaffold, placeholder `index.html`/`app.js`/`favicon.svg`.

Verify boilerplate passes:
```bash
cd ~/apps/<app-name> && npm test
```

Must pass all 6 tests (3 smoke + 3 API) before proceeding.

### 2. Database Schema

Edit `~/apps/<app-name>/init.sql` with tables, then apply:

```bash
PGPASSWORD=clawy_db_2026 psql -h 127.0.0.1 -U clawy -d <app-name> -f ~/apps/<app-name>/init.sql
```

**Always use `-h 127.0.0.1`** — bare `psql -U clawy` uses socket peer auth and will fail.

### 3. Favicon

Create `~/apps/<app-name>/public/favicon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="14" fill="<tile-color>"/>
  <text x="32" y="46" font-size="36" text-anchor="middle"><emoji></text>
</svg>
```

Tile colors: `tile-cyan` → `#2e7d9e`, `tile-purple` → `#7c3aed`, `tile-amber` → `#d97706`, `tile-pink` → `#ec4899`, `tile-green` → `#16a34a`, `tile-sand` → `#d4a76a`.

Reference in every HTML page's `<head>`:
```html
<link rel="icon" href="favicon.svg" type="image/svg+xml">
```

### 4. Systemd Service

The `clawy app create` command creates this automatically. If you need to recreate or modify:

```bash
cat > ~/.config/systemd/user/<app-name>.service << 'EOF'
[Unit]
Description=<app-name>

[Service]
WorkingDirectory=/home/openclaw/apps/<app-name>
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=<port>
Environment=PGDATABASE=<app-name>
EnvironmentFile=-/home/openclaw/apps/<app-name>/.env

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now <app-name>.service
```

All secrets go in `.env` — never in `Environment=` lines or source code.

### 5. Caddy Route

The `clawy app create` command adds this automatically. If you need to add manually, insert before the catch-all `handle` block in `~/Caddyfile`:

```
handle_path /apps/<app-name>/* {
    forward_auth 127.0.0.1:3081 {
        uri /api/auth/check
        copy_headers Cookie
    }
    reverse_proxy 127.0.0.1:<port>
}
```

Restart Caddy: `systemctl --user restart caddy.service`

### 6. Dashboard Tile

**Mandatory** — every app must be discoverable from the homepage. Edit `~/www/index.html`, add inside `.apps-grid`:

```html
<a class="app-tile tile-<color>" href="/apps/<app-name>/">
  <div class="app-icon"><emoji></div>
  <div class="app-info">
    <h3><App Name></h3>
    <p><Short description></p>
  </div>
  <span class="app-arrow">→</span>
</a>
```

### 7. Verify

```bash
cd ~/apps/<app-name> && npm test
systemctl --user is-active <app-name>.service   # must say "active"
grep '/apps/<app-name>' ~/Caddyfile             # must find the route
```

**Never share the URL until `npm test` passes and all infrastructure checks are green.**

### 8. Static-Only Apps

For apps without a backend process, serve through `~/api-server.js`:

1. Put files in `~/apps/<app-name>/public/`
2. Add route: `app.use('/apps/<app-name>', express.static('/home/openclaw/apps/<app-name>/public'));`
3. Restart: `systemctl --user restart clawy-api.service`
4. Verify: `grep '/apps/<app-name>' ~/api-server.js` AND `test -f ~/apps/<app-name>/public/index.html`

No systemd service or Caddy route needed for static apps.

## Shared Tech Stack

Include in every app's `<head>`:

```html
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/lucide@latest"></script>
<script src="/assets/clawy-tailwind.js"></script>
<script src="/components/clawy-ui.js"></script>
```

Initialize Lucide at end of `<body>`:
```html
<script>lucide.createIcons();</script>
```

Brand classes: `text-brand`, `bg-brand`, `font-display` (Space Grotesk), `font-sans` (Inter), `font-mono` (JetBrains Mono).

## Critical Rules

- **Never skip `clawy app create`** — manual setup is error-prone and takes 10-20 min vs 40 sec
- **Relative API paths only** — `fetch('api/items')` NOT `fetch('/api/items')`. No leading slash — absolute paths break under Caddy's `handle_path`
- **Auth is automatic** — Caddy's `forward_auth` protects every app. Never build a separate login system
- **All secrets in `.env`** — never in source code, never in `Environment=` lines
- **`npm test` is a hard gate** — no URL shared with the user until tests pass
