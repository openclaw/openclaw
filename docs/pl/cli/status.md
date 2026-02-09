---
summary: "Dokumentacja referencyjna CLI dla `openclaw status` (diagnostyka, sondy, migawki użycia)"
read_when:
  - Chcesz szybko zdiagnozować kondycję kanałów oraz ostatnich odbiorców sesji
  - Chcesz uzyskać wklejalny status „all” do debugowania
title: "status"
---

# `openclaw status`

Diagnostyka kanałów i sesji.

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

Uwagi:

- `--deep` uruchamia sondy na żywo (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal).
- Wyjście zawiera magazyny sesji per agent, gdy skonfigurowano wielu agentów.
- Przegląd obejmuje status instalacji i działania usługi Gateway oraz hosta węzła, gdy jest dostępny.
- Przegląd obejmuje kanał aktualizacji oraz SHA gita (dla checkoutów ze źródeł).
- Informacje o aktualizacjach są prezentowane w Przeglądzie; jeśli dostępna jest aktualizacja, status wyświetla wskazówkę, aby uruchomić `openclaw update` (zobacz [Updating](/install/updating)).
