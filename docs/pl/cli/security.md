---
summary: "Referencja CLI dla `openclaw security` (audyt i naprawa typowych pułapek bezpieczeństwa)"
read_when:
  - Chcesz uruchomić szybki audyt bezpieczeństwa konfiguracji/stanu
  - Chcesz zastosować bezpieczne sugestie „napraw” (chmod, zaostrzenie ustawień domyślnych)
title: "bezpieczeństwo"
x-i18n:
  source_path: cli/security.md
  source_hash: 96542b4784e53933
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:58Z
---

# `openclaw security`

Narzędzia bezpieczeństwa (audyt + opcjonalne naprawy).

Powiązane:

- Przewodnik bezpieczeństwa: [Bezpieczeństwo](/gateway/security)

## Audyt

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

Audyt ostrzega, gdy wielu nadawców DM współdzieli główną sesję, i zaleca **bezpieczny tryb DM**: `session.dmScope="per-channel-peer"` (lub `per-account-channel-peer` dla kanałów wielokontowych) w przypadku współdzielonych skrzynek odbiorczych.
Ostrzega również, gdy małe modele (`<=300B`) są używane bez sandboxing oraz z włączonymi narzędziami web/przeglądarki.
