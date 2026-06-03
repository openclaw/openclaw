---
name: openclaw-config-editing
description: "Safely inspect, edit, dry-run, validate, or recover OpenClaw config files."
---

# OpenClaw Config Editing

Use when editing `openclaw.json`, Gateway config, plugin config, channel config, or anything that might stop OpenClaw from starting.

## Workflow

1. Find the active config path.

   ```bash
   openclaw config file
   ```

2. Check whether the install is Nix-managed. If `OPENCLAW_NIX_MODE=1` or config writers refuse because Nix mode is active, do not edit generated `openclaw.json`; edit the Nix source instead.

3. Prefer OpenClaw-owned writes over hand-editing JSON.

   For one value:

   ```bash
   openclaw config set gateway.port 19001 --strict-json --dry-run
   openclaw config set gateway.port 19001 --strict-json
   ```

   For object-shaped or multi-key edits:

   ```bash
   openclaw config patch --file ./openclaw.patch.json5 --dry-run
   openclaw config patch --file ./openclaw.patch.json5
   ```

4. Use `--strict-json` for scalar `config set` edits that must be schema-checked. Plain value mode can accept strings that are not valid for the target field.

5. After applying, validate before restart or further changes.

   ```bash
   openclaw config validate
   ```

6. If validation fails, stop. Report the exact error, do not restart the Gateway, and either fix with another dry-run-first edit or restore the previous file.

## Direct File Edits

Only hand-edit `openclaw.json` when the CLI cannot express the change.

1. Copy a backup beside the config and harden it to owner-only permissions.
   Example: `cp -p "$config" "$config.bak" && chmod 600 "$config.bak"`.
2. Make the smallest possible edit.
3. Run `openclaw config validate` immediately.
4. Restore the backup if validation fails.

If editor help is missing, refresh the local schema next to the config:

```bash
config="$(openclaw config file)"
openclaw config schema > "$(dirname "$config")/openclaw.schema.json"
```
