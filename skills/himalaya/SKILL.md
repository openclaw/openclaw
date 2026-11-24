---
name: himalaya
description: "Himalaya CLI (2.x) for IMAP/SMTP mail: list, read, search, compose, reply, forward, copy, move, delete."
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

Use `himalaya` for IMAP/SMTP email from shell. These instructions target Himalaya 2.x: run `himalaya --version` first, because the 1.x command set differs (`folder`, `envelope list <query>`, `template`).

## References

- `references/configuration.md`: account config, auth, provider quirks.
- `references/message-composition.md`: MML syntax, now applied by an external composer.

## Setup

```bash
himalaya --version
himalaya configure
```

Config path: `~/.config/himalaya/config.toml`.

Prefer password managers or `password.command`; do not paste secrets into chat or logs.

## Read and search

```bash
himalaya mailbox list
himalaya envelope list -s 20
himalaya message read <id>
himalaya envelope search 'from alice and subject invoice'
```

`-m/--mailbox` picks a mailbox (inbox by default), `-a/--account` the account. Mailbox names come from the server and may be localized, so list them instead of guessing. Search conditions are `date`, `after`, `from`, `to`, `subject`, `body`, `flag`, combined with `and`, `or`, `not`.

## Write

```bash
himalaya message compose --to bob@example.com --subject Hi --body "text"
himalaya message compose --to bob@example.com --subject Hi --body-file /tmp/body.txt --send
himalaya message send /tmp/message.eml
himalaya message reply <id> --body "text" --send
himalaya message forward <id> --to bob@example.com --send
```

`message compose` prints RFC 5322 to stdout unless `--save` or `--send` is given. Himalaya 2.x does not parse MML itself: build multipart or rich messages with a standalone composer such as `mml` and pipe the result into `himalaya message send`.

## Organize

```bash
himalaya message move <id> --to Archive
himalaya message copy <id> --to Archive
himalaya message delete <id>
himalaya flag add <id> --flag seen
himalaya flag remove <id> --flag seen
```

## Notes

- Use `-a/--account` when several accounts exist.
- Quote exact message ids in summaries.
- 163/126 refuse every SELECT without an IMAP `ID`: set `imap.id.auto = true`, or mail reads fail with `Unsafe Login`. They also falsely advertise `SASL-IR`: set `imap.sasl-ir = false` to avoid `BAD Request not ending with` at login.
