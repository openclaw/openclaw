---
name: app-destroy
description: "Safely remove a clawy app and all its infrastructure. Use when: (1) deleting or removing an app, (2) cleaning up a failed or abandoned app, (3) uninstalling an app a user no longer needs. Reverses every step of app-deploy: stops service, removes Caddy route, removes dashboard tile, drops database, deletes directory. NOT for: deploying apps (use app-deploy), debugging (use app-debug), or database migrations (use db-migrate)."
---

# App Destroy

Safely remove a clawy app and all its infrastructure. Every step is required — partial removal leaves orphaned routes, services, and database entries.

**Destructive — confirm with the user before proceeding.**

## Pipeline (all steps required)

### 1. Stop and Disable the Service

```bash
systemctl --user stop <app-name>.service
systemctl --user disable <app-name>.service
rm ~/.config/systemd/user/<app-name>.service
systemctl --user daemon-reload
```

### 2. Remove the Caddy Route

Edit `~/Caddyfile` — remove the entire `handle_path /apps/<app-name>/* { ... }` block.

```bash
# Verify the block exists before editing
grep -n '/apps/<app-name>' ~/Caddyfile
```

Restart Caddy:
```bash
systemctl --user restart caddy.service
```

### 3. Remove the Dashboard Tile

Edit `~/www/index.html` — remove the `<a class="app-tile ...">` element for the app inside `.apps-grid`.

```bash
# Find the tile
grep -n '<app-name>' ~/www/index.html
```

### 4. Drop the Database

```bash
PGPASSWORD=clawy_db_2026 psql -h 127.0.0.1 -U clawy -c "DROP DATABASE IF EXISTS \"<app-name>\";"
```

**Always use `-h 127.0.0.1`** — bare `psql -U clawy` uses socket peer auth and will fail.

### 5. Remove Static Route (if applicable)

If the app was served via `~/api-server.js` (static app), remove the route line:

```bash
grep -n '/apps/<app-name>' ~/api-server.js
# Remove the app.use line, then:
systemctl --user restart clawy-api.service
```

### 6. Delete the App Directory

```bash
rm -rf ~/apps/<app-name>
```

Prefer `trash` over `rm` if available for recoverability.

## Verification

After all steps, confirm nothing remains:

```bash
systemctl --user status <app-name>.service 2>&1 | grep "not be found"  # should say "not be found"
grep '/apps/<app-name>' ~/Caddyfile       # should return nothing
grep '<app-name>' ~/www/index.html         # should return nothing
PGPASSWORD=clawy_db_2026 psql -h 127.0.0.1 -U clawy -lqt | grep '<app-name>'  # should return nothing
test -d ~/apps/<app-name> && echo "EXISTS" || echo "GONE"  # should say GONE
```

## Checklist

- [ ] Service stopped, disabled, unit file removed
- [ ] Caddy route removed, Caddy restarted
- [ ] Dashboard tile removed from `~/www/index.html`
- [ ] Database dropped
- [ ] Static route removed from `~/api-server.js` (if applicable)
- [ ] App directory deleted
- [ ] All verification checks pass
