---
summary: "„Zasady obsługi obrazów i multimediów dla wysyłania, Gateway oraz odpowiedzi agentów”"
read_when:
  - Modyfikowanie potoku multimediów lub załączników
title: "Obraz i obsługa mediów"
---

# Obsługa obrazów i multimediów — 2025-12-05

Kanał WhatsApp działa przez **Baileys Web**. Ten dokument opisuje aktualne zasady obsługi multimediów dla wysyłania, Gateway oraz odpowiedzi agentów.

## Cele

- Wysyłanie multimediów z opcjonalnymi podpisami za pomocą `openclaw message send --media`.
- Umożliwienie automatycznych odpowiedzi z webowej skrzynki odbiorczej, które mogą zawierać multimedia obok tekstu.
- Utrzymanie rozsądnych i przewidywalnych limitów dla poszczególnych typów.

## Interfejs CLI

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` opcjonalne; podpis może być pusty w przypadku wysyłki samych multimediów.
  - `--dry-run` wypisuje rozwiązaną treść; `--json` emituje `{ channel, to, messageId, mediaUrl, caption }`.

## Zachowanie kanału WhatsApp Web

- Wejście: lokalna ścieżka pliku **lub** adres URL HTTP(S).
- Przepływ: wczytanie do bufora, wykrycie rodzaju medium i zbudowanie właściwego ładunku:
  - **Obrazy:** zmiana rozmiaru i ponowna kompresja do JPEG (maks. bok 2048 px), celując w `agents.defaults.mediaMaxMb` (domyślnie 5 MB), z limitem 6 MB.
  - **Audio/Głos/Wideo:** przekazywane bez zmian do 16 MB; audio jest wysyłane jako notatka głosowa (`ptt: true`).
  - **Dokumenty:** wszystko inne, do 100 MB, z zachowaniem nazwy pliku, gdy jest dostępna.
- Odtwarzanie w stylu GIF w WhatsApp: wysyłanie MP4 z `gifPlayback: true` (CLI: `--gif-playback`), aby klienci mobilni odtwarzali w pętli inline.
- Wykrywanie MIME preferuje sygnatury bajtowe, następnie nagłówki, a potem rozszerzenie pliku.
- Podpis pochodzi z `--message` lub `reply.text`; pusty podpis jest dozwolony.
- Logowanie: tryb niewerbalny pokazuje `↩️`/`✅`; tryb szczegółowy zawiera rozmiar oraz źródłową ścieżkę/URL.

## Potok automatycznych odpowiedzi

- `getReplyFromConfig` zwraca `{ text?, mediaUrl?, mediaUrls? }`.
- Gdy obecne są multimedia, nadawca webowy rozwiązuje lokalne ścieżki lub adresy URL przy użyciu tego samego potoku co `openclaw message send`.
- Jeśli podano wiele pozycji multimedialnych, są one wysyłane sekwencyjnie.

## Media przychodzące do poleceń (Pi)

- Gdy przychodzące wiadomości webowe zawierają multimedia, OpenClaw pobiera je do pliku tymczasowego i udostępnia zmienne szablonów:
  - `{{MediaUrl}}` pseudo-URL dla przychodzących multimediów.
  - `{{MediaPath}}` lokalna ścieżka tymczasowa zapisana przed uruchomieniem polecenia.
- Gdy włączony jest per-sesyjny sandbox Dockera, przychodzące multimedia są kopiowane do obszaru roboczego sandbox i `MediaPath`/`MediaUrl` są przepisywane na ścieżkę względną, np. `media/inbound/<filename>`.
- Rozumienie multimediów (jeśli skonfigurowane przez `tools.media.*` lub współdzielone `tools.media.models`) działa przed szablonowaniem i może wstawiać bloki `[Image]`, `[Audio]` oraz `[Video]` do `Body`.
  - Audio ustawia `{{Transcript}}` i używa transkrypcji do parsowania poleceń, dzięki czemu polecenia ze slashem nadal działają.
  - Opisy wideo i obrazów zachowują wszelki tekst podpisu do parsowania poleceń.
- Domyślnie przetwarzany jest tylko pierwszy pasujący załącznik obrazu/audio/wideo; ustaw `tools.media.<cap>.attachments`, aby przetwarzać wiele załączników.

## Limity i błędy

**Limity wysyłki wychodzącej (WhatsApp web send)**

- Obrazy: limit ~6 MB po ponownej kompresji.
- Audio/głos/wideo: limit 16 MB; dokumenty: limit 100 MB.
- Zbyt duże lub nieczytelne multimedia → czytelny błąd w logach, a odpowiedź jest pomijana.

**Limity rozumienia multimediów (transkrypcja/opis)**

- Obraz: domyślnie 10 MB (`tools.media.image.maxBytes`).
- Audio: domyślnie 20 MB (`tools.media.audio.maxBytes`).
- Wideo: domyślnie 50 MB (`tools.media.video.maxBytes`).
- Zbyt duże multimedia pomijają etap rozumienia, ale odpowiedzi nadal są wysyłane z oryginalną treścią.

## Uwagi dotyczące testów

- Pokryć przepływy wysyłania i odpowiedzi dla przypadków obraz/audio/dokument.
- Zweryfikować ponowną kompresję obrazów (limit rozmiaru) oraz flagę notatki głosowej dla audio.
- Upewnić się, że odpowiedzi z wieloma multimediami są rozbijane na sekwencyjne wysyłki.
