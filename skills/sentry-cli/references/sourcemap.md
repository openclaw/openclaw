---
name: sentry-cli-sourcemap
version: 0.27.0
description: Manage sourcemaps
requires:
  bins: ["sentry"]
  auth: true
---

# Sourcemap Commands

Manage sourcemaps

### `sentry sourcemap inject <directory>`

Inject debug IDs into JavaScript files and sourcemaps

**Flags:**
- `--ext <value> - Comma-separated file extensions to process (default: .js,.cjs,.mjs)`
- `--dry-run - Show what would be modified without writing`

**Examples:**

```bash
# Inject debug IDs into all JS files in dist/
sentry sourcemap inject ./dist

# Preview changes without writing
sentry sourcemap inject ./dist --dry-run

# Only process specific extensions
sentry sourcemap inject ./build --ext .js,.mjs
```

### `sentry sourcemap upload <directory>`

Upload sourcemaps to Sentry

**Flags:**
- `--release <value> - Release version to associate with the upload`
- `--url-prefix <value> - URL prefix for uploaded files (default: ~/) - (default: "~/")`

**Examples:**

```bash
# Upload sourcemaps from dist/
sentry sourcemap upload ./dist

# Associate with a release
sentry sourcemap upload ./dist --release 1.0.0

# Set a custom URL prefix
sentry sourcemap upload ./dist --url-prefix '~/static/js/'
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
