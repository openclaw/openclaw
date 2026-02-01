---
name: shellfish-merchant-intel
description: Merchant discovery and registry intel for Shellfish.
homepage: https://shellfish.store
metadata:
  {"openclaw":{"emoji":"🏪","requires":{"bins":["shellfish"]}}}
---

# shellfish-merchant-intel

Merchant discovery and reputation lookups.

Quick start

- Search merchants: `shellfish merchant-intel "running"`
- Fetch by domain: `shellfish merchant-intel --domain allbirds.com`
- Browse category: `shellfish merchant-intel --category footwear`

Commands

- `shellfish merchant-intel <query>`
- `shellfish merchant-intel --domain <domain> [--json]`
- `shellfish merchant-intel --category <category>`

Notes

- Uses the Shellfish registry (default http://localhost:3333).
- Override with `--registry <url>` or `SHELLFISH_REGISTRY_URL`.
