---
summary: "Wskazówki dotyczące wyboru między heartbeat a zadaniami cron do automatyzacji"
read_when:
  - Podejmowanie decyzji, jak planować zadania cykliczne
  - Konfigurowanie monitorowania w tle lub powiadomień
  - Optymalizacja użycia tokenów dla okresowych sprawdzeń
title: "Cron vs Heartbeat"
---

# Cron vs Heartbeat: Kiedy używać którego

Zarówno heartbeat, jak i zadania cron umożliwiają uruchamianie zadań według harmonogramu. Ten przewodnik pomaga wybrać właściwy mechanizm dla Twojego przypadku użycia.

## Szybki przewodnik decyzyjny

| Przypadek użycia                                 | Zalecane                                 | Dlaczego                                           |
| ------------------------------------------------ | ---------------------------------------- | -------------------------------------------------- |
| Sprawdzanie skrzynki co 30 min                   | Heartbeat                                | Grupuje z innymi sprawdzeniami, świadome kontekstu |
| Wysyłka dziennego raportu o 9:00 | Cron (izolowany)      | Wymagane dokładne wyczucie czasu                   |
| Monitorowanie kalendarza wydarzeń                | Heartbeat                                | Naturalne dopasowanie do okresowej świadomości     |
| Cotygodniowa głęboka analiza                     | Cron (izolowany)      | Zadanie samodzielne, może używać innego modelu     |
| Przypomnij za 20 minut                           | Cron (główny, `--at`) | Jednorazowe z precyzyjnym czasem                   |
| Kontrola kondycji projektu w tle                 | Heartbeat                                | Piggybacks w istniejącym cyklu                     |

## Heartbeat: Okresowa świadomość

Heartbeat działa w **głównej sesji** w regularnych odstępach (domyślnie: co 30 min). Został zaprojektowany tak, aby agent sprawdzał różne rzeczy i sygnalizował wszystko, co istotne.

### Kiedy używać heartbeat

- **Wiele okresowych sprawdzeń**: Zamiast 5 oddzielnych zadań cron sprawdzających skrzynkę, kalendarz, pogodę, powiadomienia i status projektu, pojedynczy heartbeat może zgrupować je wszystkie.
- **Decyzje świadome kontekstu**: Agent ma pełny kontekst głównej sesji, więc potrafi rozsądnie zdecydować, co jest pilne, a co może poczekać.
- **Ciągłość konwersacji**: Uruchomienia heartbeat współdzielą tę samą sesję, więc agent pamięta ostatnie rozmowy i może naturalnie nawiązywać.
- **Monitorowanie o niskim narzucie**: Jeden heartbeat zastępuje wiele drobnych zadań odpytywania.

### Zalety heartbeat

- **Grupuje wiele sprawdzeń**: Jedna tura agenta może jednocześnie przejrzeć skrzynkę, kalendarz i powiadomienia.
- **Redukuje wywołania API**: Pojedynczy heartbeat jest tańszy niż 5 izolowanych zadań cron.
- **Świadomy kontekstu**: Agent wie, nad czym pracowałeś(-aś), i odpowiednio ustala priorytety.
- **Inteligentne tłumienie**: Jeśli nic nie wymaga uwagi, agent odpowiada `HEARTBEAT_OK` i żadna wiadomość nie jest dostarczana.
- **Naturalne wyczucie czasu**: Niewielkie dryfowanie w zależności od obciążenia kolejki, co jest akceptowalne dla większości monitoringu.

### Przykład heartbeat: lista kontrolna HEARTBEAT.md

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

Agent odczytuje to przy każdym heartbeat i obsługuje wszystkie elementy w jednej turze.

### Konfiguracja heartbeat

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // interval
        target: "last", // where to deliver alerts
        activeHours: { start: "08:00", end: "22:00" }, // optional
      },
    },
  },
}
```

Zobacz [Heartbeat](/gateway/heartbeat), aby poznać pełną konfigurację.

## Cron: Precyzyjne planowanie

Zadania cron uruchamiają się **o dokładnych porach** i mogą działać w izolowanych sesjach, nie wpływając na główny kontekst.

### Kiedy używać cron

- **Wymagana dokładna godzina**: „Wyślij to w każdy poniedziałek o 9:00” (a nie „gdzieś około 9”).
- **Zadania samodzielne**: Zadania, które nie wymagają kontekstu konwersacyjnego.
- **Inny model/sposób myślenia**: Ciężka analiza, która uzasadnia użycie potężniejszego modelu.
- **Jednorazowe przypomnienia**: „Przypomnij za 20 minut” z `--at`.
- **Głośne/częste zadania**: Zadania, które zaśmiecałyby historię głównej sesji.
- **Wyzwalacze zewnętrzne**: Zadania, które powinny działać niezależnie od aktywności agenta.

### Zalety cron

- **Dokładny czas**: 5-polowe wyrażenia cron z obsługą stref czasowych.
- **Izolacja sesji**: Uruchamia się w `cron:<jobId>` bez zanieczyszczania głównej historii.
- **Nadpisywanie modelu**: Możliwość użycia tańszego lub potężniejszego modelu dla zadania.
- **Kontrola dostarczania**: Zadania izolowane domyślnie używają `announce` (podsumowanie); w razie potrzeby wybierz `none`.
- **Natychmiastowe dostarczenie**: Tryb announce publikuje bezpośrednio, bez czekania na heartbeat.
- **Brak potrzeby kontekstu agenta**: Działa nawet, gdy główna sesja jest bezczynna lub skompaktowana.
- **Obsługa jednorazowa**: `--at` dla precyzyjnych przyszłych znaczników czasu.

### Przykład cron: Codzienny poranny briefing

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \
  --model opus \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Uruchamia się dokładnie o 7:00 czasu Nowego Jorku, używa Opus dla jakości i bezpośrednio ogłasza podsumowanie na WhatsApp.

### Przykład cron: Jednorazowe przypomnienie

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

Zobacz [Cron jobs](/automation/cron-jobs), aby uzyskać pełne referencje CLI.

## Schemat podejmowania decyzji

```
Does the task need to run at an EXACT time?
  YES -> Use cron
  NO  -> Continue...

Does the task need isolation from main session?
  YES -> Use cron (isolated)
  NO  -> Continue...

Can this task be batched with other periodic checks?
  YES -> Use heartbeat (add to HEARTBEAT.md)
  NO  -> Use cron

Is this a one-shot reminder?
  YES -> Use cron with --at
  NO  -> Continue...

Does it need a different model or thinking level?
  YES -> Use cron (isolated) with --model/--thinking
  NO  -> Use heartbeat
```

## Łączenie obu

Najbardziej efektywna konfiguracja wykorzystuje **oba**:

1. **Heartbeat** obsługuje rutynowy monitoring (skrzynka, kalendarz, powiadomienia) w jednej zgrupowanej turze co 30 minut.
2. **Cron** obsługuje precyzyjne harmonogramy (raporty dzienne, przeglądy tygodniowe) oraz jednorazowe przypomnienia.

### Przykład: Efektywna konfiguracja automatyzacji

**HEARTBEAT.md** (sprawdzany co 30 min):

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Zadania cron** (precyzyjne czasy):

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster: Deterministyczne workflow z zatwierdzeniami

Lobster to środowisko uruchomieniowe workflow dla **wielokrokowych potoków narzędzi**, które wymagają deterministycznego wykonania i jawnych zatwierdzeń.
Użyj go, gdy zadanie to więcej niż pojedyncza tura agenta i chcesz wznawialny workflow z punktami kontrolnymi dla człowieka.

### Kiedy Lobster pasuje

- **Automatyzacja wielokrokowa**: Potrzebujesz stałego potoku wywołań narzędzi, a nie jednorazowego promptu.
- **Bramki zatwierdzeń**: Efekty uboczne powinny się zatrzymać do czasu zatwierdzenia, a następnie wznowić.
- **Wznawialne uruchomienia**: Kontynuowanie wstrzymanego workflow bez ponownego wykonywania wcześniejszych kroków.

### Jak współpracuje z heartbeat i cron

- **Heartbeat/cron** decydują, _kiedy_ następuje uruchomienie.
- **Lobster** definiuje, _jakie kroki_ zachodzą po rozpoczęciu uruchomienia.

Dla zaplanowanych workflow użyj cron lub heartbeat, aby wyzwolić turę agenta, która wywoła Lobster.
Dla workflow ad-hoc wywołaj Lobster bezpośrednio.

### Uwagi operacyjne (z kodu)

- Lobster działa jako **lokalny podproces** (CLI `lobster`) w trybie narzędzia i zwraca **kopertę JSON**.
- Jeśli narzędzie zwróci `needs_approval`, wznawiasz z `resumeToken` i flagą `approve`.
- Narzędzie jest **opcjonalną wtyczką**; włączaj je addytywnie przez `tools.alsoAllow: ["lobster"]` (zalecane).
- Jeśli przekażesz `lobsterPath`, musi to być **ścieżka bezwzględna**.

Zobacz [Lobster](/tools/lobster), aby poznać pełne użycie i przykłady.

## Główna sesja vs sesja izolowana

Zarówno heartbeat, jak i cron mogą wchodzić w interakcję z główną sesją, ale w różny sposób:

|          | Heartbeat                             | Cron (główny)                      | Cron (izolowany)                    |
| -------- | ------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| Sesja    | Główna                                | Główna (przez zdarzenie systemowe) | `cron:<jobId>`                                         |
| Historia | Udostępnione                          | Udostępnione                                          | Świeża przy każdym uruchomieniu                        |
| Kontekst | Pełny                                 | Pełny                                                 | Brak (start od zera)                |
| Model    | Model głównej sesji                   | Model głównej sesji                                   | Można nadpisać                                         |
| Wyjście  | Dostarczane, jeśli nie `HEARTBEAT_OK` | Prompt heartbeat + zdarzenie                          | Ogłoszenie podsumowania (domyślnie) |

### Kiedy używać cron w głównej sesji

Użyj `--session main` z `--system-event`, gdy chcesz:

- Aby przypomnienie/zdarzenie pojawiło się w kontekście głównej sesji
- Aby agent obsłużył je podczas następnego heartbeat z pełnym kontekstem
- Brak oddzielnego, izolowanego uruchomienia

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### Kiedy używać cron izolowanego

Użyj `--session isolated`, gdy chcesz:

- Czysty łupek bez wcześniejszego kontekstu
- Inne ustawienia modelu lub sposobu myślenia
- Bezpośrednie ogłaszanie podsumowań na kanał
- Historię, która nie zaśmieca głównej sesji

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "Weekly codebase analysis..." \
  --model opus \
  --thinking high \
  --announce
```

## Kwestie kosztowe

| Mechanizm                           | Profil kosztów                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| Heartbeat                           | Jedna tura co N minut; skaluje się z rozmiarem HEARTBEAT.md       |
| Cron (główny)    | Dodaje zdarzenie do następnego heartbeat (bez izolowanej tury) |
| Cron (izolowany) | Pełna tura agenta na zadanie; można użyć tańszego modelu                          |

**Wskazówki**:

- Utrzymuj `HEARTBEAT.md` w niewielkim rozmiarze, aby zminimalizować narzut tokenów.
- Grupuj podobne sprawdzenia w heartbeat zamiast wielu zadań cron.
- Użyj `target: "none"` w heartbeat, jeśli chcesz tylko przetwarzania wewnętrznego.
- Dla rutynowych zadań używaj izolowanego cron z tańszym modelem.

## Powiązane

- [Heartbeat](/gateway/heartbeat) – pełna konfiguracja heartbeat
- [Cron jobs](/automation/cron-jobs) – pełne referencje CLI i API dla cron
- [System](/cli/system) – zdarzenia systemowe + kontrola heartbeat
