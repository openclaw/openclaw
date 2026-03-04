---
name: coscli
description: Tencent Cloud COS CLI for bucket/object operations (install, config, ls/cp/sync/rm/signurl).
metadata:
  {
    "openclaw":
      {
        "emoji": "COS",
        "requires": { "bins": ["coscli"] },
      },
  }
---

# coscli

Use `coscli` for Tencent Cloud COS operations from terminal.

## Install (official)

- Linux:
  - `wget https://cosbrowser.cloud.tencent.com/software/coscli/coscli-linux -O coscli`
  - `chmod 755 ./coscli`
  - `sudo mv ./coscli /usr/local/bin/coscli`
- macOS:
  - `wget https://cosbrowser.cloud.tencent.com/software/coscli/coscli-mac -O coscli`
  - `chmod 755 ./coscli`
  - `sudo mv ./coscli /usr/local/bin/coscli`
- Windows:
  - Download `coscli-windows.exe` from the official install page and add it to `PATH`.

Verify:

- `coscli -v`

## Configure credentials

Initialize config interactively:

- `coscli config init`

Use least-privilege credentials (prefer temporary credentials when possible). Do not print or commit `SecretId`/`SecretKey`.

## Path format

- COS URL format: `cos://<bucket-name-appid>/<object-key>`
- Bucket names in commands should include `-appid`.

## Quick start

- List buckets/objects:
  - `coscli ls`
  - `coscli ls cos://example-1250000000/`
- Upload/download/copy:
  - `coscli cp ./local.txt cos://example-1250000000/path/local.txt`
  - `coscli cp cos://example-1250000000/path/local.txt ./local.txt`
  - `coscli cp cos://src-1250000000/a.txt cos://dst-1250000000/b.txt`
- Directory sync:
  - `coscli sync ./dist cos://example-1250000000/site/`
  - `coscli sync cos://example-1250000000/site/ ./site-backup`
- Delete:
  - `coscli rm cos://example-1250000000/path/local.txt`
  - `coscli rm -r cos://example-1250000000/path/`
- Bucket create/delete:
  - `coscli mb cos://newbucket-1250000000`
  - `coscli rb cos://newbucket-1250000000`
- Signed URL:
  - `coscli signurl cos://example-1250000000/path/local.txt --timeout 600`

## Safe usage defaults

- Prefer dry-run style checks with `ls` before `rm -r` or overwrite sync.
- When syncing to production paths, confirm source/destination explicitly.
- Avoid destructive flags unless user clearly requests deletion behavior.
