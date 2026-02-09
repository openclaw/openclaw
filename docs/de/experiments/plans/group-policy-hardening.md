---
summary: "„Telegram-Allowlist-Härtung: Präfix- und Whitespace-Normalisierung“"
read_when:
  - Überprüfung historischer Änderungen an der Telegram-Allowlist
title: "Telegram-Allowlist-Härtung"
---

# Telegram-Allowlist-Härtung

**Datum**: 2026-01-05  
**Status**: Abgeschlossen  
**PR**: #216

## Zusammenfassung

Telegram-Allowlists akzeptieren jetzt die Präfixe `telegram:` und `tg:` ohne Beachtung der Groß-/Kleinschreibung und tolerieren
versehentliches Whitespace. Dies gleicht die eingehenden Allowlist-Prüfungen mit der Normalisierung beim ausgehenden Senden ab.

## Was sich geändert hat

- Die Präfixe `telegram:` und `tg:` werden gleich behandelt (ohne Beachtung der Groß-/Kleinschreibung).
- Allowlist-Einträge werden getrimmt; leere Einträge werden ignoriert.

## Beispiele

Alle folgenden Varianten werden für dieselbe ID akzeptiert:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## Warum das wichtig ist

Kopieren/Einfügen aus Logs oder Chat-IDs enthält häufig Präfixe und Whitespace. Die Normalisierung vermeidet
False Negatives bei der Entscheidung, ob in Direktnachrichten oder Gruppen geantwortet werden soll.

## Zugehörige Dokumente

- [Group Chats](/channels/groups)
- [Telegram Provider](/channels/telegram)
