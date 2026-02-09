---
summary: "Referencja CLI dla `openclaw directory` (self, peers, groups)"
read_when:
  - Chcesz wyszukać identyfikatory kontaktów/grup/siebie dla kanału
  - Tworzysz adapter katalogu kanałów
title: "directory"
---

# `openclaw directory`

Wyszukiwanie w katalogu dla kanałów, które to obsługują (kontakty/peers, grupy oraz „ja”).

## Common flags

- `--channel <name>`: identyfikator/alias kanału (wymagany, gdy skonfigurowano wiele kanałów; automatyczny, gdy skonfigurowano tylko jeden)
- `--account <id>`: identyfikator konta (domyślnie: domyślne konto kanału)
- `--json`: wyjście JSON

## Notes

- `directory` ma pomóc w znalezieniu identyfikatorów, które można wkleić do innych poleceń (zwłaszcza `openclaw message send --target ...`).
- Dla wielu kanałów wyniki są oparte na konfiguracji (listy dozwolonych / skonfigurowane grupy), a nie na katalogu dostawcy w czasie rzeczywistym.
- Domyślne wyjście to `id` (a czasem `name`) rozdzielone tabulatorem; do skryptów użyj `--json`.

## Using results with `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID formats (by channel)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (grupa)
- Telegram: `@username` lub numeryczny identyfikator czatu; grupy mają numeryczne identyfikatory
- Slack: `user:U…` oraz `channel:C…`
- Discord: `user:<id>` oraz `channel:<id>`
- Matrix (wtyczka): `user:@user:server`, `room:!roomId:server` lub `#alias:server`
- Microsoft Teams (wtyczka): `user:<id>` oraz `conversation:<id>`
- Zalo (wtyczka): identyfikator użytkownika (Bot API)
- Zalo Personal / `zalouser` (wtyczka): identyfikator wątku (DM/grupa) z `zca` (`me`, `friend list`, `group list`)

## Self („me”)

```bash
openclaw directory self --channel zalouser
```

## Peers (contacts/users)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## Groups

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
