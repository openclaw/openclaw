---
summary: "Rozwiązywanie problemów z parowaniem węzłów, wymaganiami pierwszoplanowymi, uprawnieniami i awariami narzędzi"
read_when:
  - Węzeł jest połączony, ale narzędzia kamery/płótna/ekranu/exec nie działają
  - Potrzebny jest model mentalny parowania węzła w porównaniu z zatwierdzeniami
title: "Rozwiązywanie problemów węzła"
---

# Rozwiązywanie problemów węzła

Użyj tej strony, gdy węzeł jest widoczny w statusie, ale narzędzia węzła nie działają.

## Drabina poleceń

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Następnie uruchom kontrole specyficzne dla węzła:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

Zdrowe sygnały:

- Węzeł jest połączony i sparowany dla roli `node`.
- `nodes describe` obejmuje wywoływaną możliwość.
- Zatwierdzenia exec pokazują oczekiwany tryb/listę dozwolonych.

## Wymagania pierwszoplanowe

`canvas.*`, `camera.*` i `screen.*` są dostępne wyłącznie w trybie pierwszoplanowym na węzłach iOS/Android.

Szybkie sprawdzenie i naprawa:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

Jeśli zobaczysz `NODE_BACKGROUND_UNAVAILABLE`, przenieś aplikację węzła na pierwszy plan i spróbuj ponownie.

## Macierz uprawnień

| Możliwość                    | iOS                                                              | Android                                                                    | Aplikacja węzła macOS                                    | Typowy kod błędu               |
| ---------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | Aparat (+ mikrofon dla dźwięku klipu)         | Aparat (+ mikrofon dla dźwięku klipu)                   | Aparat (+ mikrofon dla dźwięku klipu) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | Nagrywanie ekranu (+ mikrofon opcjonalnie)    | Monit o przechwytywanie ekranu (+ mikrofon opcjonalnie) | Nagrywanie ekranu                                        | `*_PERMISSION_REQUIRED`        |
| `location.get`               | Podczas użycia lub Zawsze (zależnie od trybu) | Lokalizacja na pierwszym planie/w tle w zależności od trybu                | Uprawnienie lokalizacji                                  | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/d (ścieżka hosta węzła)                     | n/d (ścieżka hosta węzła)                               | Wymagane zatwierdzenia exec                              | `SYSTEM_RUN_DENIED`            |

## Parowanie a zatwierdzenia

To są różne bramki:

1. **Parowanie urządzenia**: czy ten węzeł może połączyć się z gateway?
2. **Zatwierdzenia exec**: czy ten węzeł może uruchomić konkretne polecenie powłoki?

Szybkie kontrole:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

Jeśli brakuje parowania, najpierw zatwierdź urządzenie węzła.
Jeśli parowanie jest poprawne, ale `system.run` nie działa, napraw zatwierdzenia exec/listę dozwolonych.

## Typowe kody błędów węzła

- `NODE_BACKGROUND_UNAVAILABLE` → aplikacja działa w tle; przenieś ją na pierwszy plan.
- `CAMERA_DISABLED` → przełącznik kamery wyłączony w ustawieniach węzła.
- `*_PERMISSION_REQUIRED` → brakujące/odrzucone uprawnienie systemowe.
- `LOCATION_DISABLED` → tryb lokalizacji jest wyłączony.
- `LOCATION_PERMISSION_REQUIRED` → żądany tryb lokalizacji nie został przyznany.
- `LOCATION_BACKGROUND_UNAVAILABLE` → aplikacja działa w tle, ale istnieje tylko uprawnienie „Podczas użycia”.
- `SYSTEM_RUN_DENIED: approval required` → żądanie exec wymaga jawnego zatwierdzenia.
- `SYSTEM_RUN_DENIED: allowlist miss` → polecenie zablokowane przez tryb listy dozwolonych.

## Szybka pętla odzyskiwania

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

Jeśli nadal występuje problem:

- Ponownie zatwierdź parowanie urządzenia.
- Ponownie otwórz aplikację węzła (pierwszy plan).
- Ponownie nadaj uprawnienia systemowe.
- Odtwórz/dostosuj politykę zatwierdzeń exec.

Powiązane:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
