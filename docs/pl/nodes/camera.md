---
summary: "„Przechwytywanie obrazu z kamery (węzeł iOS + aplikacja macOS) do użycia przez agenta: zdjęcia (jpg) i krótkie klipy wideo (mp4)”"
read_when:
  - Dodawanie lub modyfikowanie przechwytywania z kamery na węzłach iOS lub macOS
  - Rozszerzanie przepływów pracy tymczasowych plików MEDIA dostępnych dla agenta
title: "„Przechwytywanie z kamery”"
---

# Przechwytywanie z kamery (agent)

OpenClaw obsługuje **przechwytywanie z kamery** na potrzeby przepływów pracy agenta:

- **Węzeł iOS** (sparowany przez Gateway): wykonanie **zdjęcia** (`jpg`) lub **krótkiego klipu wideo** (`mp4`, z opcjonalnym dźwiękiem) przez `node.invoke`.
- **Węzeł Android** (sparowany przez Gateway): wykonanie **zdjęcia** (`jpg`) lub **krótkiego klipu wideo** (`mp4`, z opcjonalnym dźwiękiem) przez `node.invoke`.
- **Aplikacja macOS** (węzeł przez Gateway): wykonanie **zdjęcia** (`jpg`) lub **krótkiego klipu wideo** (`mp4`, z opcjonalnym dźwiękiem) przez `node.invoke`.

Cały dostęp do kamery jest chroniony **ustawieniami kontrolowanymi przez użytkownika**.

## Węzeł iOS

### Ustawienie użytkownika (domyślnie włączone)

- Karta Ustawienia iOS → **Kamera** → **Zezwól na kamerę** (`camera.enabled`)
  - Domyślnie: **włączone** (brak klucza jest traktowany jako włączone).
  - Gdy wyłączone: polecenia `camera.*` zwracają `CAMERA_DISABLED`.

### Polecenia (przez Gateway `node.invoke`)

- `camera.list`
  - Ładunek odpowiedzi:
    - `devices`: tablica `{ id, name, position, deviceType }`

- `camera.snap`
  - Parametry:
    - `facing`: `front|back` (domyślnie: `front`)
    - `maxWidth`: liczba (opcjonalne; domyślnie `1600` na węźle iOS)
    - `quality`: `0..1` (opcjonalne; domyślnie `0.9`)
    - `format`: obecnie `jpg`
    - `delayMs`: liczba (opcjonalne; domyślnie `0`)
    - `deviceId`: ciąg znaków (opcjonalne; z `camera.list`)
  - Ładunek odpowiedzi:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - Ochrona ładunku: zdjęcia są ponownie kompresowane, aby utrzymać ładunek base64 poniżej 5 MB.

- `camera.clip`
  - Parametry:
    - `facing`: `front|back` (domyślnie: `front`)
    - `durationMs`: liczba (domyślnie `3000`, ograniczona do maks. `60000`)
    - `includeAudio`: boolean (domyślnie `true`)
    - `format`: obecnie `mp4`
    - `deviceId`: ciąg znaków (opcjonalne; z `camera.list`)
  - Ładunek odpowiedzi:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### Wymóg pierwszoplanowy

Podobnie jak `canvas.*`, węzeł iOS zezwala na polecenia `camera.*` wyłącznie na **pierwszym planie**. Wywołania w tle zwracają `NODE_BACKGROUND_UNAVAILABLE`.

### Pomocnik CLI (pliki tymczasowe + MEDIA)

Najprostszym sposobem uzyskania załączników jest użycie pomocnika CLI, który zapisuje zdekodowane media do pliku tymczasowego i wypisuje `MEDIA:<path>`.

Przykłady:

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

Uwagi:

- `nodes camera snap` domyślnie obejmuje **oba** ustawienia kamery, aby agent miał oba widoki.
- Pliki wyjściowe są tymczasowe (w katalogu tymczasowym systemu operacyjnego), chyba że zbudujesz własny wrapper.

## Węzeł Android

### Ustawienie użytkownika Android (domyślnie włączone)

- Arkusz Ustawień Android → **Kamera** → **Zezwól na kamerę** (`camera.enabled`)
  - Domyślnie: **włączone** (brak klucza jest traktowany jako włączone).
  - Gdy wyłączone: polecenia `camera.*` zwracają `CAMERA_DISABLED`.

### Permissions

- Android wymaga uprawnień w czasie działania:
  - `CAMERA` dla `camera.snap` i `camera.clip`.
  - `RECORD_AUDIO` dla `camera.clip`, gdy `includeAudio=true`.

Jeśli brakuje uprawnień, aplikacja wyświetli monit, gdy to możliwe; jeśli zostaną odrzucone, żądania `camera.*` kończą się błędem
`*_PERMISSION_REQUIRED`.

### Wymóg pierwszego planu Android

Podobnie jak `canvas.*`, węzeł Android zezwala na polecenia `camera.*` wyłącznie na **pierwszym planie**. Wywołania w tle zwracają `NODE_BACKGROUND_UNAVAILABLE`.

### Ochrona ładunku

Zdjęcia są ponownie kompresowane, aby utrzymać ładunek base64 poniżej 5 MB.

## Aplikacja macOS

### Ustawienie użytkownika (domyślnie wyłączone)

Aplikacja towarzysząca macOS udostępnia pole wyboru:

- **Ustawienia → Ogólne → Zezwól na kamerę** (`openclaw.cameraEnabled`)
  - Domyślnie: **wyłączone**
  - Gdy wyłączone: żądania kamery zwracają „Camera disabled by user”.

### Pomocnik CLI (wywołanie węzła)

Użyj głównego CLI `openclaw`, aby wywoływać polecenia kamery na węźle macOS.

Przykłady:

```bash
openclaw nodes camera list --node <id>            # list camera ids
openclaw nodes camera snap --node <id>            # prints MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # prints MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # prints MEDIA:<path> (legacy flag)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

Uwagi:

- `openclaw nodes camera snap` domyślnie ma wartość `maxWidth=1600`, o ile nie zostanie nadpisana.
- W systemie macOS `camera.snap` czeka `delayMs` (domyślnie 2000 ms) po rozgrzewce/ustabilizowaniu ekspozycji przed wykonaniem zdjęcia.
- Ładunki zdjęć są ponownie kompresowane, aby utrzymać base64 poniżej 5 MB.

## Bezpieczeństwo + praktyczne limity

- Dostęp do kamery i mikrofonu wywołuje standardowe monity uprawnień systemu operacyjnego (i wymaga odpowiednich wpisów usage strings w Info.plist).
- Klipy wideo są ograniczane (obecnie `<= 60s`), aby uniknąć zbyt dużych ładunków węzła (narzut base64 + limity wiadomości).

## Wideo ekranu macOS (na poziomie systemu)

W przypadku wideo _ekranu_ (nie kamery) użyj aplikacji towarzyszącej macOS:

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

Uwagi:

- Wymaga uprawnienia macOS **Screen Recording** (TCC).
