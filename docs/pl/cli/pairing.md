---
summary: "Dokumentacja referencyjna CLI dla `openclaw pairing` (zatwierdzanie/listowanie żądań parowania)"
read_when:
  - Używasz DM-ów w trybie parowania i musisz zatwierdzać nadawców
title: "parowanie"
x-i18n:
  source_path: cli/pairing.md
  source_hash: 785869d24d953141
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:54Z
---

# `openclaw pairing`

Zatwierdzaj lub sprawdzaj żądania parowania DM-ów (dla kanałów obsługujących parowanie).

Powiązane:

- Przepływ parowania: [Pairing](/channels/pairing)

## Polecenia

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <code> --notify
```
