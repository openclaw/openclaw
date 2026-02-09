---
summary: "Referencja CLI dla `openclaw browser` (profile, karty, akcje, przekaźnik rozszerzenia)"
read_when:
  - Używasz `openclaw browser` i chcesz przykładów typowych zadań
  - Chcesz sterować przeglądarką uruchomioną na innej maszynie za pośrednictwem hosta węzła
  - Chcesz używać przekaźnika rozszerzenia Chrome (podłączanie/odłączanie przyciskiem na pasku narzędzi)
title: "browser"
---

# `openclaw browser`

Zarządzaj serwerem sterowania przeglądarką OpenClaw i uruchamiaj akcje przeglądarki (karty, migawki, zrzuty ekranu, nawigacja, kliknięcia, wpisywanie).

Powiązane:

- Narzędzie przeglądarki + API: [Browser tool](/tools/browser)
- Przekaźnik rozszerzenia Chrome: [Chrome extension](/tools/chrome-extension)

## Common flags

- `--url <gatewayWsUrl>`: adres URL WebSocket Gateway (domyślnie z konfiguracji).
- `--token <token>`: token Gateway (jeśli wymagany).
- `--timeout <ms>`: limit czasu żądania (ms).
- `--browser-profile <name>`: wybór profilu przeglądarki (domyślny z konfiguracji).
- `--json`: wyjście czytelne dla maszyn (tam, gdzie obsługiwane).

## Quick start (local)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Profiles

Profile to nazwane konfiguracje routingu przeglądarki. W praktyce:

- `openclaw`: uruchamia/dołącza do dedykowanej instancji Chrome zarządzanej przez OpenClaw (izolowany katalog danych użytkownika).
- `chrome`: steruje Twoimi istniejącymi kartami Chrome za pośrednictwem przekaźnika rozszerzenia Chrome.

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

Użyj konkretnego profilu:

```bash
openclaw browser --browser-profile work tabs
```

## Tabs

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## Snapshot / screenshot / actions

Snapshot:

```bash
openclaw browser snapshot
```

Zrzut ekranu:

```bash
openclaw browser screenshot
```

Nawigacja/kliknięcia/wpisywanie (automatyzacja UI oparta na referencjach):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome extension relay (attach via toolbar button)

Ten tryb pozwala agentowi sterować istniejącą kartą Chrome, którą dołączasz ręcznie (nie następuje automatyczne dołączanie).

Zainstaluj rozpakowane rozszerzenie w stabilnej ścieżce:

```bash
openclaw browser extension install
openclaw browser extension path
```

Następnie Chrome → `chrome://extensions` → włącz „Tryb dewelopera” → „Załaduj rozpakowane” → wybierz wydrukowany folder.

Pełny przewodnik: [Chrome extension](/tools/chrome-extension)

## Remote browser control (node host proxy)

Jeśli Gateway działa na innej maszynie niż przeglądarka, uruchom **host węzła** na maszynie z Chrome/Brave/Edge/Chromium. Gateway będzie pośredniczyć w akcjach przeglądarki do tego węzła (nie jest wymagany osobny serwer sterowania przeglądarką).

Użyj `gateway.nodes.browser.mode` do kontrolowania automatycznego routingu oraz `gateway.nodes.browser.node` do przypięcia konkretnego węzła, jeśli podłączonych jest wiele.

Bezpieczeństwo + konfiguracja zdalna: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
