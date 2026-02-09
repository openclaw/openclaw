---
summary: "Lista kontrolna wydania krok po kroku dla npm + aplikacji macOS"
read_when:
  - Przygotowywanie nowego wydania npm
  - Przygotowywanie nowego wydania aplikacji macOS
  - Weryfikacja metadanych przed publikacją
---

# Lista kontrolna wydania (npm + macOS)

Użyj `pnpm` (Node 22+) z katalogu głównego repozytorium. Przed tagowaniem/publikacją zachowaj czyste drzewo robocze.

## Wyzwalacz operatora

Gdy operator powie „release”, natychmiast wykonaj to sprawdzenie wstępne (bez dodatkowych pytań, chyba że coś blokuje):

- Przeczytaj ten dokument oraz `docs/platforms/mac/release.md`.
- Załaduj zmienne środowiskowe z `~/.profile` i potwierdź, że ustawione są `SPARKLE_PRIVATE_KEY_FILE` oraz zmienne App Store Connect (SPARKLE_PRIVATE_KEY_FILE powinien znajdować się w `~/.profile`).
- W razie potrzeby użyj kluczy Sparkle z `~/Library/CloudStorage/Dropbox/Backup/Sparkle`.

1. **Wersja i metadane**

- [ ] Zwiększ wersję `package.json` (np. `2026.1.29`).
- [ ] Uruchom `pnpm plugins:sync`, aby wyrównać wersje pakietów rozszerzeń oraz changelogi.
- [ ] Zaktualizuj ciągi wersji CLI: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) oraz user agent Baileys w [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts).
- [ ] Potwierdź metadane pakietu (name, description, repository, keywords, license) oraz to, że mapa `bin` wskazuje na [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) dla `openclaw`.
- [ ] Jeśli zmieniły się zależności, uruchom `pnpm install`, aby `pnpm-lock.yaml` było aktualne.

2. **Build i artefakty**

- [ ] Jeśli zmieniły się wejścia A2UI, uruchom `pnpm canvas:a2ui:bundle` i zatwierdź wszelkie zaktualizowane [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js).
- [ ] `pnpm run build` (regeneruje `dist/`).
- [ ] Sprawdź, czy pakiet npm `files` zawiera wszystkie wymagane foldery `dist/*` (w szczególności `dist/node-host/**` i `dist/acp/**` dla headless node + ACP CLI).
- [ ] Potwierdź, że `dist/build-info.json` istnieje i zawiera oczekiwany hash `commit` (baner CLI używa tego przy instalacjach npm).
- [ ] Opcjonalnie: `npm pack --pack-destination /tmp` po buildzie; obejrzyj zawartość tarballa i zachowaj go do wydania GitHub (nie **zatwierdzaj** go w repozytorium).

3. **Changelog i dokumentacja**

- [ ] Zaktualizuj `CHANGELOG.md` o najważniejsze zmiany widoczne dla użytkownika (utwórz plik, jeśli nie istnieje); zachowaj wpisy ściśle w kolejności malejącej według wersji.
- [ ] Upewnij się, że przykłady i flagi w README odpowiadają aktualnemu zachowaniu CLI (zwłaszcza nowe polecenia lub opcje).

4. **Walidacja**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (lub `pnpm test:coverage`, jeśli potrzebujesz wyjścia z pokryciem)
- [ ] `pnpm release:check` (weryfikuje zawartość npm pack)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (test dymny instalacji Docker, szybka ścieżka; wymagany przed wydaniem)
  - Jeśli bezpośrednio poprzednie wydanie npm jest znane jako uszkodzone, ustaw `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` lub `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` dla kroku preinstall.
- [ ] (Opcjonalnie) Pełny test dymny instalatora (dodaje użytkownika bez uprawnień roota + pokrycie CLI): `pnpm test:install:smoke`
- [ ] (Opcjonalnie) E2E instalatora (Docker, uruchamia `curl -fsSL https://openclaw.ai/install.sh | bash`, wykonuje onboarding, a następnie realne wywołania narzędzi):
  - `pnpm test:install:e2e:openai` (wymaga `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (wymaga `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (wymaga obu kluczy; uruchamia obu dostawców)
- [ ] (Opcjonalnie) Szybko sprawdź web gateway, jeśli zmiany dotyczą ścieżek wysyłania/odbioru.

5. **Aplikacja macOS (Sparkle)**

- [ ] Zbuduj i podpisz aplikację macOS, a następnie spakuj ją do zipa do dystrybucji.
- [ ] Wygeneruj appcast Sparkle (notatki HTML przez [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)) i zaktualizuj `appcast.xml`.
- [ ] Zachowaj zip aplikacji (oraz opcjonalny zip dSYM) gotowy do dołączenia do wydania GitHub.
- [ ] Postępuj zgodnie z [macOS release](/platforms/mac/release) w celu uzyskania dokładnych poleceń i wymaganych zmiennych środowiskowych.
  - `APP_BUILD` musi być numeryczny i monotoniczny (bez `-beta`), aby Sparkle poprawnie porównywał wersje.
  - Jeśli wykonujesz notaryzację, użyj profilu pęku kluczy `openclaw-notary` utworzonego na podstawie zmiennych środowiskowych App Store Connect API (zobacz [macOS release](/platforms/mac/release)).

6. **Publikacja (npm)**

- [ ] Potwierdź, że stan git jest czysty; w razie potrzeby zatwierdź i wypchnij zmiany.
- [ ] `npm login` (weryfikacja 2FA), jeśli wymagane.
- [ ] `npm publish --access public` (użyj `--tag beta` dla wydań wstępnych).
- [ ] Zweryfikuj rejestr: `npm view openclaw version`, `npm view openclaw dist-tags` oraz `npx -y openclaw@X.Y.Z --version` (lub `--help`).

### Rozwiązywanie problemów (notatki z wydania 2.0.0-beta2)

- **npm pack/publish zawiesza się lub tworzy ogromny tarball**: pakiet aplikacji macOS w `dist/OpenClaw.app` (oraz zipy wydań) są wciągane do pakietu. Naprawa: dodaj listę dozwoloną zawartości publikacji przez `package.json` `files` (uwzględnij podkatalogi dist, docs, skills; wyklucz pakiety aplikacji). Potwierdź poleceniem `npm pack --dry-run`, że `dist/OpenClaw.app` nie znajduje się na liście.
- **Pętla uwierzytelniania npm w przeglądarce dla dist-tags**: użyj uwierzytelniania legacy, aby uzyskać monit o OTP:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **Weryfikacja `npx` nie powodzi się z `ECOMPROMISED: Lock compromised`**: spróbuj ponownie z czystą pamięcią podręczną:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **Tag wymaga przestawienia po późnej poprawce**: wymuś aktualizację i wypchnij tag, a następnie upewnij się, że artefakty wydania GitHub nadal się zgadzają:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **Wydanie GitHub + appcast**

- [ ] Otaguj i wypchnij: `git tag vX.Y.Z && git push origin vX.Y.Z` (lub `git push --tags`).
- [ ] Utwórz/odśwież wydanie GitHub dla `vX.Y.Z` z **tytułem `openclaw X.Y.Z`** (nie tylko tag); treść powinna zawierać **pełną** sekcję changeloga dla tej wersji (Highlights + Changes + Fixes), wstawioną bezpośrednio (bez gołych linków), i **nie może powtarzać tytułu wewnątrz treści**.
- [ ] Dołącz artefakty: tarball `npm pack` (opcjonalnie), `OpenClaw-X.Y.Z.zip` oraz `OpenClaw-X.Y.Z.dSYM.zip` (jeśli wygenerowano).
- [ ] Zatwierdź zaktualizowany `appcast.xml` i wypchnij go (Sparkle pobiera z gałęzi main).
- [ ] Z czystego katalogu tymczasowego (bez `package.json`) uruchom `npx -y openclaw@X.Y.Z send --help`, aby potwierdzić, że instalacja i punkty wejścia CLI działają.
- [ ] Ogłoś/udostępnij informacje o wydaniu.

## Zakres publikacji wtyczek (npm)

Publikujemy wyłącznie **istniejące wtyczki npm** w zakresie `@openclaw/*`. Dołączone
wtyczki, których nie ma na npm, pozostają **tylko w drzewie dyskowym** (nadal są dostarczane w
`extensions/**`).

Proces wyprowadzenia listy:

1. `npm search @openclaw --json` i zapisz nazwy pakietów.
2. Porównaj z nazwami `extensions/*/package.json`.
3. Opublikuj tylko **część wspólną** (już obecną na npm).

Aktualna lista wtyczek npm (aktualizuj w razie potrzeby):

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/discord
- @openclaw/feishu
- @openclaw/lobster
- @openclaw/matrix
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/voice-call
- @openclaw/zalo
- @openclaw/zalouser

Informacje o wydaniu muszą również wskazywać **nowe opcjonalne dołączone wtyczki**, które **nie są
włączone domyślnie** (przykład: `tlon`).
