---
name: himalaya
description: "Himalaya CLI for IMAP/SMTP mail: list, read, search, compose, reply, forward, copy, move, delete."
homepage: https://github.com/pimalaya/himalaya
metadata:
  {
    "openclaw":
      {
        "emoji": "📧",
        "requires": { "bins": ["himalaya"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "himalaya",
              "bins": ["himalaya"],
              "label": "Install Himalaya (brew)",
            },
          ],
      },
  }
---

# Himalaya

Use `himalaya` for IMAP/SMTP email from shell.

## References

- `references/configuration.md`: account config, auth, backend setup.
- `references/message-composition.md`: message format, MML syntax, compose commands.

## Setup

```bash
himalaya --version
himalaya account configure
```

Config path: `~/.config/himalaya/config.toml`.

Prefer password managers/keyrings for credentials; do not paste secrets into chat/logs.

## Read/search

```bash
himalaya folder list
himalaya envelope list
himalaya message read <id>
himalaya envelope search from alice@example.com and subject invoice
```

## Write

```bash
himalaya message compose --to bob@example.com --subject "Hello" --body "Hi Bob"
himalaya message send < /tmp/message.txt
himalaya message reply <id> --body "Thanks"
himalaya message forward <id> --to carol@example.com
```

`compose`, `reply` and `forward` print the message; add `--send` to send it. Use `--attach <path>` for attachments; read `references/message-composition.md` for raw messages.

## Organize

```bash
himalaya message copy <id> --to <folder>
himalaya message move <id> --to <folder>
himalaya message delete <id>
himalaya flag add <id> --flag seen
himalaya flag remove <id> --flag seen
```

## Notes

- Use `--account` when multiple accounts exist.
- Quote exact message IDs in summaries.
