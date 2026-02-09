---
summary: "Przepływ pracy z Bun (eksperymentalny): instalacja i pułapki w porównaniu z pnpm"
read_when:
  - Chcesz najszybszej lokalnej pętli developerskiej (bun + watch)
  - Napotykasz problemy z instalacją/łatkami/skryptami cyklu życia w Bun
title: "Bun (eksperymentalny)"
---

# Bun (eksperymentalny)

Cel: uruchomić to repozytorium z **Bun** (opcjonalnie, niezalecane dla WhatsApp/Telegram),
bez odchodzenia od przepływów pracy pnpm.

⚠️ **Niezalecane dla środowiska uruchomieniowego Gateway** (błędy WhatsApp/Telegram). Do produkcji używaj Node.

## Status

- Bun jest opcjonalnym lokalnym runtime do bezpośredniego uruchamiania TypeScript (`bun run …`, `bun --watch …`).
- `pnpm` jest domyślne dla buildów i pozostaje w pełni wspierane (i używane przez część narzędzi dokumentacyjnych).
- Bun nie może używać `pnpm-lock.yaml` i zignoruje go.

## Instalacja

Domyślnie:

```sh
bun install
```

Uwaga: `bun.lock`/`bun.lockb` są ignorowane przez git, więc w obu przypadkach nie ma zmian w repozytorium. Jeśli chcesz _braku zapisów lockfile_:

```sh
bun install --no-save
```

## Build / Testy (Bun)

```sh
bun run build
bun run vitest run
```

## Skrypty cyklu życia Bun (domyślnie blokowane)

Bun może blokować skrypty cyklu życia zależności, o ile nie zostaną jawnie zaufane (`bun pm untrusted` / `bun pm trust`).
Dla tego repozytorium najczęściej blokowane skrypty nie są wymagane:

- `@whiskeysockets/baileys` `preinstall`: sprawdza główną wersję Node >= 20 (używamy Node 22+).
- `protobufjs` `postinstall`: emituje ostrzeżenia o niezgodnych schematach wersjonowania (brak artefaktów builda).

Jeśli napotkasz rzeczywisty problem w czasie działania, który wymaga tych skryptów, zaufaj im jawnie:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Zastrzeżenia

- Niektóre skrypty nadal mają na stałe wpisane pnpm (np. `docs:build`, `ui:*`, `protocol:check`). Na razie uruchamiaj je przez pnpm.
