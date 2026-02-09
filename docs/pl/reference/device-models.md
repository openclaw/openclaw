---
summary: "Jak OpenClaw dostarcza mapowania identyfikatorów modeli urządzeń Apple na przyjazne nazwy w aplikacji na macOS."
read_when:
  - Aktualizowanie mapowań identyfikatorów modeli urządzeń lub plików NOTICE/licencji
  - Zmiana sposobu wyświetlania nazw urządzeń w interfejsie Instances
title: "Baza modeli urządzeń"
---

# Baza modeli urządzeń (przyjazne nazwy)

Aplikacja towarzysząca na macOS wyświetla przyjazne nazwy modeli urządzeń Apple w interfejsie **Instances**, mapując identyfikatory modeli Apple (np. `iPad16,6`, `Mac16,6`) na nazwy czytelne dla użytkownika.

Mapowanie jest dostarczane w postaci JSON pod ścieżką:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## Źródło danych

Obecnie dostarczamy mapowanie z repozytorium na licencji MIT:

- `kyle-seongwoo-jun/apple-device-identifiers`

Aby zachować deterministyczność buildów, pliki JSON są przypięte do konkretnych commitów upstream (zapisanych w `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`).

## Aktualizowanie bazy danych

1. Wybierz commity upstream, do których chcesz przypiąć (po jednym dla iOS i macOS).
2. Zaktualizuj hashe commitów w `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`.
3. Ponownie pobierz pliki JSON, przypięte do tych commitów:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. Upewnij się, że `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` nadal jest zgodny z upstream (zastąp go, jeśli licencja upstream ulegnie zmianie).
5. Zweryfikuj, że aplikacja na macOS buduje się poprawnie (bez ostrzeżeń):

```bash
swift build --package-path apps/macos
```
