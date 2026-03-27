---
name: rclone-remote-check
description: Validate rclone remote configuration and run safe connectivity checks for cloud/NAS targets. Use when users ask to confirm Google Drive/S3/OneDrive/WebDAV remotes, troubleshoot upload failures, or validate backup destination access.
---

# Rclone Remote Check

Confirm remotes are configured and usable.

## Prerequisites

Run:

```bash
rclone version
rclone listremotes
```

If no remotes exist, stop and ask user to run `rclone config`.

## Validate a specific remote

Given `<remote>`:

```bash
rclone about <remote>:
rclone lsd <remote>:
```

For path-level checks:

```bash
rclone lsf <remote>:<path>
```

## Optional write test (with approval)

Use only after explicit approval:

```bash
echo test > /tmp/rclone-test.txt
rclone copy /tmp/rclone-test.txt <remote>:<path>
rclone lsf <remote>:<path> --include "rclone-test.txt"
rclone delete <remote>:<path>/rclone-test.txt
```

On Windows, use a temp file path under `%TEMP%`.

## Reporting

Return:

- remote name
- auth/connectivity status
- list/read test result
- write/delete test result (if run)
- exact failing command if broken

## Failure handling

Map failures to likely causes:

- auth/token expired
- wrong remote name/path
- permission denied on destination
- network/proxy/firewall issue

Provide the smallest corrective step first.
