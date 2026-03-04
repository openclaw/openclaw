---
name: ossutil
description: Alibaba Cloud OSS CLI for bucket/object operations (install, config, ls/cp/sync/rm/sign).
metadata: { "openclaw": { "emoji": "OSS", "requires": { "bins": ["ossutil"] } } }
---

# ossutil

Use `ossutil` to manage Alibaba Cloud Object Storage Service (OSS) from the terminal.
This skill targets the `ossutil` (v1-style) command interface.

## Install (official docs)

Follow the official install guide for your OS (Windows/macOS/Linux), then verify:

- `ossutil --version`

Notes:

- For `ossutil` 1.6.16+, binary name is `ossutil`.
- Commands in this skill are for the `ossutil` binary/interface.

## Configure credentials

Create config interactively:

- `ossutil config`

Or create/update config file:

- `ossutil config -e <endpoint> -i <AccessKeyId> -k <AccessKeySecret> [-t <SecurityToken>]`

Use least-privilege RAM credentials. Prefer temporary credentials (`SecurityToken`) when possible.

## Path format

- OSS URL format: `oss://<bucket>/<object-key>`

Examples:

- `oss://example-bucket/`
- `oss://example-bucket/path/file.txt`

## Quick start commands

- List:
  - `ossutil ls`
  - `ossutil ls oss://example-bucket/`
- Upload/download/copy:
  - `ossutil cp ./local.txt oss://example-bucket/path/local.txt`
  - `ossutil cp oss://example-bucket/path/local.txt ./local.txt`
  - `ossutil cp oss://src-bucket/a.txt oss://dst-bucket/b.txt`
- Sync:
  - `ossutil sync ./dist oss://example-bucket/site/`
  - `ossutil sync oss://example-bucket/site/ ./site-backup`
- Delete:
  - `ossutil rm oss://example-bucket/path/local.txt`
  - `ossutil rm -r oss://example-bucket/path/`
- Buckets:
  - `ossutil mb oss://new-bucket`
  - `ossutil rb oss://new-bucket`
- Sign URL:
  - `ossutil sign oss://example-bucket/path/local.txt --timeout 600`

## Common command families (from overview)

- Config: `config`
- Bucket lifecycle: `mb`, `rb`, `bucket-*`
- Object operations: `ls`, `cp`, `sync`, `rm`, `cat`, `hash`
- Multipart helpers: `lsparts`, `abort`
- Restore/sign/link: `restore`, `sign`, `symlink`
- API-level commands: `ossutil api <operation>`

## Safe usage defaults

- Run `ls` first before destructive actions (`rm -r`, overwrite sync).
- Confirm source and destination explicitly for cross-bucket copy/sync.
- Avoid exposing AccessKey/Secret in logs or committed files.
