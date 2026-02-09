---
summary: "Parowanie węzłów należących do Gateway (Opcja B) dla iOS i innych węzłów zdalnych"
read_when:
  - Implementowanie zatwierdzania parowania węzłów bez interfejsu macOS
  - Dodawanie przepływów CLI do zatwierdzania węzłów zdalnych
  - Rozszerzanie protokołu gateway o zarządzanie węzłami
title: "Parowanie bramy"
---

# Parowanie należące do Gateway (Opcja B)

W parowaniu należącym do Gateway **Gateway** jest źródłem prawdy określającym, które węzły
mają prawo dołączać. Interfejsy (aplikacja macOS, przyszli klienci) są jedynie frontendami,
które zatwierdzają lub odrzucają oczekujące żądania.

**Ważne:** Węzły WS używają **parowania urządzenia** (rola `node`) podczas `connect`.
`node.pair.*` jest osobnym magazynem parowania i **nie** bramkuje uzgadniania WS.
Tylko klienci, którzy jawnie wywołują `node.pair.*`, korzystają z tego przepływu.

## Pojęcia

- **Oczekujące żądanie**: węzeł poprosił o dołączenie; wymaga zatwierdzenia.
- **Sparowany węzeł**: zatwierdzony węzeł z wydanym tokenem uwierzytelniającym.
- **Transport**: punkt końcowy WS Gateway przekazuje żądania, ale nie decyduje
  o członkostwie. (Obsługa starszego mostu TCP jest przestarzała/usunięta).

## Jak działa parowanie

1. Węzeł łączy się z WS Gateway i żąda parowania.
2. Gateway zapisuje **oczekujące żądanie** i emituje `node.pair.requested`.
3. Zatwierdzasz lub odrzucasz żądanie (CLI lub UI).
4. Po zatwierdzeniu Gateway wydaje **nowy token** (tokeny są rotowane przy ponownym parowaniu).
5. Węzeł łączy się ponownie, używając tokenu, i jest teraz „sparowany”.

Oczekujące żądania wygasają automatycznie po **5 minutach**.

## Przepływ CLI (przyjazny dla trybu bezgłowego)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` pokazuje sparowane/połączone węzły oraz ich możliwości.

## Powierzchnia API (protokół gateway)

Zdarzenia:

- `node.pair.requested` — emitowane, gdy tworzona jest nowa oczekująca prośba.
- `node.pair.resolved` — emitowane, gdy prośba zostaje zatwierdzona/odrzucona/wygasa.

Metody:

- `node.pair.request` — utworzenie lub ponowne użycie oczekującej prośby.
- `node.pair.list` — lista oczekujących + sparowanych węzłów.
- `node.pair.approve` — zatwierdzenie oczekującej prośby (wydaje token).
- `node.pair.reject` — odrzucenie oczekującej prośby.
- `node.pair.verify` — weryfikacja `{ nodeId, token }`.

Uwagi:

- `node.pair.request` jest idempotentne na węzeł: powtarzane wywołania zwracają to samo
  oczekujące żądanie.
- Zatwierdzenie **zawsze** generuje świeży token; żaden token nigdy nie jest zwracany z
  `node.pair.request`.
- Prośby mogą zawierać `silent: true` jako wskazówkę dla przepływów autozatwierdzania.

## Autozatwierdzanie (aplikacja macOS)

Aplikacja macOS może opcjonalnie spróbować **cichego zatwierdzenia**, gdy:

- prośba jest oznaczona jako `silent`, oraz
- aplikacja może zweryfikować połączenie SSH z hostem gateway, używając tego samego użytkownika.

Jeśli ciche zatwierdzenie się nie powiedzie, następuje powrót do standardowego monitu „Zatwierdź/Odrzuć”.

## Przechowywanie (lokalne, prywatne)

Stan parowania jest przechowywany w katalogu stanu Gateway (domyślnie `~/.openclaw`):

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

Jeśli nadpiszesz `OPENCLAW_STATE_DIR`, folder `nodes/` przeniesie się wraz z nim.

Uwagi dotyczące bezpieczeństwa:

- Tokeny są sekretami; traktuj `paired.json` jako wrażliwe.
- Rotacja tokenu wymaga ponownego zatwierdzenia (lub usunięcia wpisu węzła).

## Zachowanie transportu

- Transport jest **bezstanowy**; nie przechowuje członkostwa.
- Jeśli Gateway jest offline lub parowanie jest wyłączone, węzły nie mogą się parować.
- Jeśli Gateway działa w trybie zdalnym, parowanie nadal odbywa się względem magazynu zdalnego Gateway.
