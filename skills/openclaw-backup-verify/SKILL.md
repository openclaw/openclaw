---
name: openclaw-backup-verify
description: Validate OpenClaw backup archives and restore readiness with repeatable checks. Use when users ask to confirm backup integrity, test migration safety, or verify that a backup file is usable before moving systems.
---

# OpenClaw Backup Verify

Verify backup files and confirm restore readiness.

## Run verification

Use:

```bash
openclaw backup verify <archive-path>
```

For structured output:

```bash
openclaw backup verify <archive-path> --json
```

## Basic checklist

1. Confirm file exists and is readable.
2. Run `openclaw backup verify`.
3. Confirm result indicates a valid manifest/payload.
4. Record archive timestamp, size, and checksum.

## Optional integrity checks

Use a checksum before transfer and after transfer:

```bash
# Linux/macOS
sha256sum <archive-path>

# PowerShell
Get-FileHash <archive-path> -Algorithm SHA256
```

## Migration readiness report

Return a short report with:

- archive path
- verification result (pass/fail)
- checksum value (if computed)
- restore confidence summary
- next step recommendation

## Failure handling

If verification fails, report:

- exact command and error
- likely cause (corruption, incomplete transfer, wrong file)
- minimal next fix (recreate backup, re-copy archive, retry verify)

Never claim restore readiness when verification fails.
