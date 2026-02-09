---
summary: "„Cykl życia Gateway na macOS (launchd)”"
read_when:
  - Integracja aplikacji macOS z cyklem życia Gateway
title: "„Cykl życia Gateway”"
---

# Cykl życia Gateway na macOS

Aplikacja macOS **domyślnie zarządza Gateway za pomocą launchd** i nie uruchamia
Gateway jako procesu potomnego. Najpierw próbuje podłączyć się do już działającego
Gateway na skonfigurowanym porcie; jeśli żaden nie jest osiągalny, włącza usługę
launchd za pomocą zewnętrznego CLI `openclaw` (bez wbudowanego runtime). Zapewnia to niezawodny automatyczny start przy logowaniu oraz restart po awariach.

Tryb procesu potomnego (Gateway uruchamiany bezpośrednio przez aplikację)
**nie jest obecnie używany**.
Jeśli potrzebujesz ściślejszego powiązania z UI,
uruchom Gateway ręcznie w terminalu.

## Domyślne zachowanie (launchd)

- Aplikacja instaluje per‑użytkownikowy LaunchAgent oznaczony etykietą `bot.molt.gateway`
  (lub `bot.molt.<profile>` przy użyciu `--profile`/`OPENCLAW_PROFILE`; starszy `com.openclaw.*` jest obsługiwany).
- Gdy włączony jest tryb Lokalny, aplikacja upewnia się, że LaunchAgent jest załadowany,
  i w razie potrzeby uruchamia Gateway.
- Logi są zapisywane w ścieżce logów gateway launchd (widoczne w Ustawieniach debugowania).

Typowe polecenia:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Zastąp etykietę wartością `bot.molt.<profile>` podczas uruchamiania nazwanego profilu.

## Nieoznaczone deweloperskie kompilacje

`scripts/restart-mac.sh --no-sign` jest przeznaczony do szybkich lokalnych kompilacji, gdy nie masz
kluczy podpisu. Aby zapobiec temu, by launchd wskazywał na niepodpisany binarny relay, wykonuje on:

- Zapis `~/.openclaw/disable-launchagent`.

Podpisane uruchomienia `scripts/restart-mac.sh` usuwają to nadpisanie, jeśli znacznik jest
obecny. Aby zresetować ręcznie:

```bash
rm ~/.openclaw/disable-launchagent
```

## Tryb tylko‑podłączania

Aby wymusić, by aplikacja macOS **nigdy nie instalowała ani nie zarządzała launchd**,
uruchom ją z `--attach-only` (lub `--no-launchd`). Ustawia to `~/.openclaw/disable-launchagent`,
dzięki czemu aplikacja tylko podłącza się do już działającego Gateway. To samo
zachowanie można przełączyć w Ustawieniach debugowania.

## Tryb zdalny

Tryb zdalny nigdy nie uruchamia lokalnego Gateway. Aplikacja używa tunelu SSH do
zdalnego hosta i łączy się przez ten tunel.

## Dlaczego preferujemy launchd

- Automatyczny start przy logowaniu.
- Wbudowane mechanizmy restartu/KeepAlive.
- Przewidywalne wpisy i nadzór.

Jeśli kiedykolwiek ponownie potrzebny będzie prawdziwy tryb procesu potomnego,
powinien on zostać udokumentowany jako osobny, wyraźny tryb tylko dla deweloperów.
