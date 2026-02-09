---
summary: "Uwierzytelnianie modeli: OAuth, klucze API i setup-token"
read_when:
  - Debugowanie uwierzytelniania modelu lub wygaśnięcia OAuth
  - Dokumentowanie uwierzytelniania lub przechowywania poświadczeń
title: "Uwierzytelnianie"
---

# Uwierzytelnianie

OpenClaw obsługuje OAuth i klucze API dla dostawców modeli. Dla kont Anthropic
zalecamy użycie **klucza API**. W przypadku dostępu do subskrypcji Claude
użyj długowiecznego tokenu utworzonego przez `claude setup-token`.

Pełny przepływ OAuth i układ przechowywania opisano w
[/concepts/oauth](/concepts/oauth).

## Zalecana konfiguracja Anthropic (klucz API)

Jeśli korzystasz bezpośrednio z Anthropic, użyj klucza API.

1. Utwórz klucz API w konsoli Anthropic.
2. Umieść go na **hoście gateway (hoście bramy)** (maszynie uruchamiającej `openclaw gateway`).

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Jeśli Gateway działa pod systemd/launchd, zaleca się umieszczenie klucza w
   `~/.openclaw/.env`, aby demon mógł go odczytać:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

Następnie uruchom ponownie demona (lub zrestartuj proces Gateway) i sprawdź ponownie:

```bash
openclaw models status
openclaw doctor
```

Jeśli wolisz nie zarządzać zmiennymi środowiskowymi samodzielnie, kreator wdrożeniowy
może zapisać klucze API do użycia przez demona: `openclaw onboard`.

Szczegóły dotyczące dziedziczenia zmiennych środowiskowych znajdziesz w
[Pomocy](/help) (`env.shellEnv`, `~/.openclaw/.env`, systemd/launchd).

## Anthropic: setup-token (uwierzytelnianie subskrypcji)

Dla Anthropic zalecaną ścieżką jest **klucz API**. Jeśli korzystasz z subskrypcji Claude,
obsługiwany jest również przepływ setup-token. Uruchom go na **hoście gateway (hoście bramy)**:

```bash
claude setup-token
```

Następnie wklej go do OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

Jeśli token został utworzony na innej maszynie, wklej go ręcznie:

```bash
openclaw models auth paste-token --provider anthropic
```

Jeśli zobaczysz błąd Anthropic, taki jak:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…zamiast tego użyj klucza API Anthropic.

Ręczne wprowadzanie tokenu (dowolny dostawca; zapisuje `auth-profiles.json` + aktualizuje konfigurację):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

Sprawdzenie przyjazne automatyzacji (zwraca kod wyjścia `1` przy wygaśnięciu/braku, `2` gdy wkrótce wygaśnie):

```bash
openclaw models status --check
```

Opcjonalne skrypty operacyjne (systemd/Termux) są opisane tutaj:
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` wymaga interaktywnego TTY.

## Sprawdzanie stanu uwierzytelniania modelu

```bash
openclaw models status
openclaw doctor
```

## Kontrolowanie, które poświadczenie jest używane

### Na sesję (komenda czatu)

Użyj `/model <alias-or-id>@<profileId>`, aby przypiąć konkretne poświadczenie dostawcy dla bieżącej sesji
(przykładowe identyfikatory profili: `anthropic:default`, `anthropic:work`).

Użyj `/model` (lub `/model list`) dla kompaktowego wyboru; użyj `/model status` dla widoku pełnego
(kandydaci + następny profil uwierzytelniania oraz szczegóły punktu końcowego dostawcy, gdy są skonfigurowane).

### Na agenta (nadpisanie w CLI)

Ustaw jawne nadpisanie kolejności profili uwierzytelniania dla agenta
(zapisywane w `auth-profiles.json` tego agenta):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

Użyj `--agent <id>`, aby wskazać konkretnego agenta; pomiń, aby użyć skonfigurowanego agenta domyślnego.

## Rozwiązywanie problemów

### „Nie znaleziono poświadczeń”

Jeśli brakuje profilu tokenu Anthropic, uruchom `claude setup-token` na
**hoście gateway (hoście bramy)**, a następnie sprawdź ponownie:

```bash
openclaw models status
```

### Token wygasa/wygasł

Uruchom `openclaw models status`, aby potwierdzić, który profil wygasa. Jeśli profilu
brakuje, uruchom ponownie `claude setup-token` i wklej token jeszcze raz.

## Wymagania

- Subskrypcja Claude Max lub Pro (dla `claude setup-token`)
- Zainstalowany Claude Code CLI (dostępne polecenie `claude`)
