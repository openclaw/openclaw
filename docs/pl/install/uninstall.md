---
summary: "Całkowite odinstalowanie OpenClaw (CLI, usługa, stan, obszar roboczy)"
read_when:
  - Chcesz usunąć OpenClaw z maszyny
  - Usługa gateway nadal działa po odinstalowaniu
title: "Odinstalowanie"
---

# Odinstalowanie

Dwie ścieżki:

- **Łatwa ścieżka**, jeśli `openclaw` jest nadal zainstalowane.
- **Ręczne usunięcie usługi**, jeśli CLI zniknęło, ale usługa nadal działa.

## Łatwa ścieżka (CLI nadal zainstalowane)

Zalecane: użyj wbudowanego deinstalatora:

```bash
openclaw uninstall
```

Tryb nieinteraktywny (automatyzacja / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

Kroki ręczne (ten sam efekt):

1. Zatrzymaj usługę gateway:

```bash
openclaw gateway stop
```

2. Odinstaluj usługę gateway (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. Usuń stan + konfigurację:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

Jeśli ustawiono `OPENCLAW_CONFIG_PATH` na niestandardową lokalizację poza katalogiem stanu, usuń także ten plik.

4. Usuń obszar roboczy (opcjonalne, usuwa pliki agenta):

```bash
rm -rf ~/.openclaw/workspace
```

5. Usuń instalację CLI (wybierz metodę, której użyto):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. Jeśli zainstalowano aplikację na macOS:

```bash
rm -rf /Applications/OpenClaw.app
```

Uwagi:

- Jeśli używano profili (`--profile` / `OPENCLAW_PROFILE`), powtórz krok 3 dla każdego katalogu stanu (domyślne to `~/.openclaw-<profile>`).
- W trybie zdalnym katalog stanu znajduje się na **hoście gateway**, więc wykonaj tam również kroki 1–4.

## Ręczne usunięcie usługi (CLI nie jest zainstalowane)

Użyj tej metody, jeśli usługa gateway nadal działa, ale brakuje `openclaw`.

### macOS (launchd)

Domyślna etykieta to `bot.molt.gateway` (lub `bot.molt.<profile>`; starsza `com.openclaw.*` może nadal istnieć):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

Jeśli używano profilu, zastąp etykietę i nazwę plist wartością `bot.molt.<profile>`. Usuń wszelkie starsze pliki plist `com.openclaw.*`, jeśli występują.

### Linux (jednostka użytkownika systemd)

Domyślna nazwa jednostki to `openclaw-gateway.service` (lub `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Zaplanowane zadanie)

Domyślna nazwa zadania to `OpenClaw Gateway` (lub `OpenClaw Gateway (<profile>)`).
Skrypt zadania znajduje się w katalogu stanu.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

Jeśli używano profilu, usuń odpowiadającą nazwę zadania oraz `~\.openclaw-<profile>\gateway.cmd`.

## Instalacja standardowa vs. checkout ze źródeł

### Instalacja standardowa (install.sh / npm / pnpm / bun)

Jeśli użyto `https://openclaw.ai/install.sh` lub `install.ps1`, CLI zostało zainstalowane za pomocą `npm install -g openclaw@latest`.
Usuń je poleceniem `npm rm -g openclaw` (lub `pnpm remove -g` / `bun remove -g`, jeśli zainstalowano w ten sposób).

### Checkout ze źródeł (git clone)

Jeśli uruchamiasz z checkoutu repozytorium (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. Odinstaluj usługę gateway **przed** usunięciem repozytorium (użyj łatwej ścieżki powyżej lub ręcznego usunięcia usługi).
2. Usuń katalog repozytorium.
3. Usuń stan + obszar roboczy, jak pokazano powyżej.
