---
summary: "Adds configured catalog feed source validation for skills and plugins."
read_when:
  - You are installing, configuring, or auditing the feeds plugin
title: "Feeds plugin"
---

# Feeds plugin

Adds configured catalog feed source validation for skills and plugins.

## Distribution

- Package: `@openclaw/feeds`
- Install route: included in OpenClaw

## Surface

plugin

## Configure feed sources

Feed sources live under the bundled `feeds` plugin config. A source can point at
an `https://` or `file://` feed document and can optionally be pinned by
integrity.

```jsonc
{
  "plugins": {
    "entries": {
      "feeds": {
        "enabled": true,
        "config": {
          "sources": [
            {
              "id": "company-approved",
              "url": "https://feeds.example.com/openclaw/feed.json",
              "trust": "pinned",
              "integrity": "sha256:...",
            },
          ],
        },
      },
    },
  },
}
```

## Discover entries

```bash
openclaw feeds sources
openclaw feeds list --source company-approved
openclaw feeds search calendar --type plugin
```

## Install from a feed

`openclaw feeds install` resolves exactly one feed entry, checks the configured
feed install policy, and then hands off to the existing OpenClaw skill or plugin
install command. The feeds plugin does not introduce a second installer.

```bash
openclaw feeds install calendar-helper --source company-approved --type plugin --dry-run
openclaw feeds install calendar-helper --source company-approved --type plugin
openclaw feeds install calendar-helper --source company-approved --type plugin --force
```

Use `--dry-run` to print the underlying install command without running it. Use
`--force` to forward force behavior to the existing installer.

## Install policy

`installPolicy` controls approval checks for explicit feed-backed installs.

```jsonc
{
  "plugins": {
    "entries": {
      "feeds": {
        "enabled": true,
        "config": {
          "installPolicy": {
            "mode": "enforce",
            "requireApproval": true,
          },
          "sources": [
            {
              "id": "company-approved",
              "url": "file:///opt/openclaw/feeds/company.json",
            },
          ],
        },
      },
    },
  },
}
```

- `mode: "off"` performs no approval check.
- `mode: "warn"` reports unapproved entries and continues.
- `mode: "enforce"` blocks unapproved entries.
- `requireApproval: true` requires `approval.status: "approved"` on feed entries.

If `requireApproval` is `true` and `mode` is omitted, OpenClaw treats the policy
as enforce. If `mode` is `enforce` and `requireApproval` is omitted, approval is
required.
