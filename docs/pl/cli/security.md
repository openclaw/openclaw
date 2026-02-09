---
summary: "Referencja CLI dla `openclaw security` (audyt i naprawa typowych pułapek bezpieczeństwa)"
read_when:
  - Chcesz uruchomić szybki audyt bezpieczeństwa konfiguracji/stanu
  - Chcesz zastosować bezpieczne sugestie „napraw” (chmod, zaostrzenie ustawień domyślnych)
title: "bezpieczeństwo"
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
