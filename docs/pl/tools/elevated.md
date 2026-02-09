---
summary: "Tryb podwyższonego wykonania i dyrektywy /elevated"
read_when:
  - Dostosowywanie domyślnych ustawień trybu podwyższonego, list dozwolonych lub zachowania poleceń ukośnych
title: "Tryb podwyższony"
---

# Tryb podwyższony (/elevated directives)

## Co to robi

- `/elevated on` działa na hoście Gateway i zachowuje zatwierdzanie wykonania (tak samo jak `/elevated ask`).
- `/elevated full` działa na hoście Gateway **i** automatycznie zatwierdza wykonanie (pomija zatwierdzanie exec).
- `/elevated ask` działa na hoście Gateway, ale zachowuje zatwierdzanie wykonania (tak samo jak `/elevated on`).
- `on`/`ask` **nie** wymuszają `exec.security=full`; nadal obowiązuje skonfigurowana polityka bezpieczeństwa/zapytań.
- Zmienia zachowanie tylko wtedy, gdy agent jest **sandboxed** (w przeciwnym razie exec już działa na hoście).
- Formy dyrektyw: `/elevated on|off|ask|full`, `/elev on|off|ask|full`.
- Akceptowane są wyłącznie `on|off|ask|full`; wszystko inne zwraca podpowiedź i nie zmienia stanu.

## Co kontroluje (a czego nie)

- **Bramki dostępności**: `tools.elevated` jest globalną linią bazową. `agents.list[].tools.elevated` może dodatkowo ograniczyć tryb podwyższony per agent (oba muszą zezwalać).
- **Stan per sesja**: `/elevated on|off|ask|full` ustawia poziom podwyższenia dla bieżącego klucza sesji.
- **Dyrektywa inline**: `/elevated on|ask|full` wewnątrz wiadomości dotyczy tylko tej wiadomości.
- **Grupy**: W czatach grupowych dyrektywy podwyższone są honorowane tylko wtedy, gdy agent jest wspomniany. Wiadomości zawierające wyłącznie polecenia, które omijają wymagania dotyczące wspomnień, są traktowane jak wspomniane.
- **Wykonanie na hoście**: tryb podwyższony wymusza `exec` na hoście Gateway; `full` ustawia także `security=full`.
- **Zatwierdzenia**: `full` pomija zatwierdzanie wykonania; `on`/`ask` respektują je, gdy wymagają tego reguły listy dozwolonych/zapytań.
- **Agenci bez sandbox**: brak wpływu na lokalizację; wpływa tylko na bramkowanie, logowanie i status.
- **Polityka narzędzi nadal obowiązuje**: jeśli `exec` jest zabronione przez politykę narzędzi, tryb podwyższony nie może być użyty.
- **Oddzielne od `/exec`**: `/exec` dostosowuje domyślne ustawienia per sesja dla autoryzowanych nadawców i nie wymaga trybu podwyższonego.

## Kolejność rozstrzygania

1. Dyrektywa inline w wiadomości (dotyczy tylko tej wiadomości).
2. Nadpisanie sesji (ustawiane przez wysłanie wiadomości zawierającej wyłącznie dyrektywę).
3. Globalne ustawienie domyślne (`agents.defaults.elevatedDefault` w konfiguracji).

## Ustawianie domyślnego poziomu sesji

- Wyślij wiadomość, która jest **tylko** dyrektywą (dozwolone białe znaki), np. `/elevated full`.
- Wysyłana jest odpowiedź potwierdzająca (`Elevated mode set to full...` / `Elevated mode disabled.`).
- Jeśli dostęp do trybu podwyższonego jest wyłączony lub nadawca nie znajduje się na zatwierdzonej liście dozwolonych, dyrektywa odpowiada wykonalnym błędem i nie zmienia stanu sesji.
- Wyślij `/elevated` (lub `/elevated:`) bez argumentu, aby zobaczyć bieżący poziom podwyższenia.

## Dostępność + listy dozwolonych

- Bramka funkcji: `tools.elevated.enabled` (domyślnie może być wyłączona w konfiguracji, nawet jeśli kod ją obsługuje).
- Lista dozwolonych nadawców: `tools.elevated.allowFrom` z listami per dostawca (np. `discord`, `whatsapp`).
- Bramka per agent: `agents.list[].tools.elevated.enabled` (opcjonalna; może tylko dodatkowo ograniczać).
- Lista dozwolonych per agent: `agents.list[].tools.elevated.allowFrom` (opcjonalna; gdy ustawiona, nadawca musi pasować do **obu** list: globalnej i per agent).
- Fallback dla Discorda: jeśli `tools.elevated.allowFrom.discord` jest pominięte, jako fallback używana jest lista `channels.discord.dm.allowFrom`. Ustaw `tools.elevated.allowFrom.discord` (nawet `[]`), aby nadpisać. Listy per agent **nie** używają fallbacku.
- Wszystkie bramki muszą przejść; w przeciwnym razie tryb podwyższony jest traktowany jako niedostępny.

## Logowanie + status

- Wywołania exec w trybie podwyższonym są logowane na poziomie info.
- Status sesji zawiera tryb podwyższony (np. `elevated=ask`, `elevated=full`).
