---
summary: "List, initialize, and test configured storage locations"
title: "storage"
read_when:
  - You are connecting a disk or object store as a storage location
  - You need to check storage access or encryption keys
---

# `openclaw storage`

Manage named destinations configured under `storage.locations`. See
[Storage locations](/concepts/storage-locations) for configuration, encryption,
and provider contracts.

```bash
openclaw storage list
openclaw storage init archive
openclaw storage test archive
```

All three commands accept `--json`, including before the subcommand:

```bash
openclaw storage list --json
openclaw storage --json init archive
openclaw storage test archive --json
```

## List

`storage list` shows each configured location, its provider, its display target
when available, and its check state.
Checking reads the location marker and checks access and the encryption key. It
does not initialize locations or write test objects. Providers that report
capacity include free and total bytes in JSON output.

## Initialize

`storage init <name>` writes the location's identity and encryption marker with
a create-only operation. Repeating it with the same encryption configuration
verifies the existing marker; it does not replace it. A wrong passphrase fails.

For a `filesystem` location, the configured absolute path must already exist
and be a directory. OpenClaw never creates this root directory. Confirm that an
external disk is mounted before initializing its location.

Initialization is explicit so a disconnected disk or an empty mount point cannot
silently become a new destination. If a runtime operation reports a missing
marker, reconnect the disk or check the bucket and prefix. Initialize the location
only if it is new. For example:

> Storage location "r2test" (r2://bucket/prefix) has no initialization marker. If this is a new location, run `openclaw storage init r2test`; otherwise reconnect the disk or check the bucket and prefix.

## Test

`storage test <name>` writes a small, unique `.openclaw-probe-<uuid>` object at the location root, reads
it back through the configured encryption layer, verifies every byte, and deletes
the object. It requires an initialized location and never initializes one.
No check directory is created on filesystem locations.

A successful JSON result includes `state: "ok"` and `sizeBytes`. A failed write,
read-back verification, or cleanup fails the command. If a provider is unreachable
during cleanup, reconnect it before removing any leftover check objects.

Storage locations can contain credentials and private conversations. Use
encryption unless the destination is already protected and you deliberately
choose `encryption: "none"`.
