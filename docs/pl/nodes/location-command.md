---
summary: "Polecenie lokalizacji dla węzłów (location.get), tryby uprawnień i zachowanie w tle"
read_when:
  - Dodawanie obsługi węzła lokalizacji lub interfejsu uprawnień
  - Projektowanie przepływów lokalizacji w tle + powiadomień push
title: "Polecenie lokalizacji"
---

# nodes/location-command.md

## TL;DR

- `location.get` to polecenie węzła (przez `node.invoke`).
- Domyślnie wyłączone.
- Ustawienia używają selektora: Wył. / Podczas użycia / Zawsze.
- Oddzielny przełącznik: Dokładna lokalizacja.

## Dlaczego selektor (a nie tylko przełącznik)

Uprawnienia systemowe są wielopoziomowe. Możemy udostępnić selektor w aplikacji, ale to system operacyjny decyduje o faktycznym przyznaniu.

- iOS/macOS: użytkownik może wybrać **Podczas użycia** lub **Zawsze** w monitach/ustawieniach systemu. Aplikacja może poprosić o podniesienie poziomu, ale system może wymagać przejścia do Ustawień.
- Android: lokalizacja w tle jest osobnym uprawnieniem; na Androidzie 10+ często wymaga to przepływu przez Ustawienia.
- Dokładna lokalizacja jest osobnym przyznaniem (iOS 14+ „Precise”, Android „fine” vs „coarse”).

Selektor w UI steruje żądanym trybem; faktyczne przyznanie znajduje się w ustawieniach systemu.

## Model ustawień

Na urządzenie węzła:

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

Zachowanie UI:

- Wybranie `whileUsing` żąda uprawnienia na pierwszym planie.
- Wybranie `always` najpierw zapewnia `whileUsing`, a następnie żąda uprawnienia w tle (lub kieruje użytkownika do Ustawień, jeśli jest to wymagane).
- Jeśli system odmówi żądanego poziomu, następuje powrót do najwyższego przyznanego poziomu i wyświetlenie statusu.

## Mapowanie uprawnień (node.permissions)

Opcjonalne. Węzeł macOS raportuje `location` poprzez mapę uprawnień; iOS/Android mogą to pominąć.

## Polecenie: `location.get`

Wywoływane przez `node.invoke`.

Parametry (sugerowane):

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

Ładunek odpowiedzi:

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "altitudeMeters": 182.0,
  "speedMps": 0.0,
  "headingDeg": 270.0,
  "timestamp": "2026-01-03T12:34:56.000Z",
  "isPrecise": true,
  "source": "gps|wifi|cell|unknown"
}
```

Błędy (stabilne kody):

- `LOCATION_DISABLED`: selektor jest wyłączony.
- `LOCATION_PERMISSION_REQUIRED`: brak uprawnienia dla żądanego trybu.
- `LOCATION_BACKGROUND_UNAVAILABLE`: aplikacja jest w tle, ale dozwolone jest tylko „Podczas użycia”.
- `LOCATION_TIMEOUT`: brak ustalenia lokalizacji w czasie.
- `LOCATION_UNAVAILABLE`: błąd systemu / brak dostawców.

## Zachowanie w tle (przyszłość)

Cel: model może żądać lokalizacji nawet wtedy, gdy węzeł działa w tle, ale tylko gdy:

- Użytkownik wybrał **Zawsze**.
- System operacyjny przyznaje lokalizację w tle.
- Aplikacja ma prawo działać w tle dla lokalizacji (tryb pracy w tle iOS / usługa pierwszoplanowa Android lub specjalne zezwolenie).

Przepływ wyzwalany powiadomieniem push (przyszłość):

1. Gateway wysyła powiadomienie push do węzła (ciche push lub dane FCM).
2. Węzeł krótko się wybudza i żąda lokalizacji od urządzenia.
3. Węzeł przekazuje ładunek do Gateway.

Uwagi:

- iOS: wymagane uprawnienie „Zawsze” + tryb lokalizacji w tle. Ciche push mogą być dławione; należy oczekiwać sporadycznych niepowodzeń.
- Android: lokalizacja w tle może wymagać usługi pierwszoplanowej; w przeciwnym razie należy oczekiwać odmowy.

## Integracja modelu/narzędzi

- Powierzchnia narzędzia: narzędzie `nodes` dodaje akcję `location_get` (wymagany węzeł).
- CLI: `openclaw nodes location get --node <id>`.
- Wytyczne dla agenta: wywoływać tylko wtedy, gdy użytkownik włączył lokalizację i rozumie zakres.

## Teksty UX (sugerowane)

- Wył.: „Udostępnianie lokalizacji jest wyłączone.”
- Podczas użycia: „Tylko gdy OpenClaw jest otwarty.”
- Zawsze: „Zezwól na lokalizację w tle. Wymaga uprawnienia systemowego.”
- Dokładna: „Użyj dokładnej lokalizacji GPS. Wyłącz, aby udostępniać lokalizację przybliżoną.”
