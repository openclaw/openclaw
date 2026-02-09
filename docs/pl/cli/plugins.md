---
summary: "Referencja CLI dla `openclaw plugins` (lista, instalacja, włączanie/wyłączanie, diagnostyka)"
read_when:
  - Chcesz zainstalować lub zarządzać wtyczkami Gateway działającymi w procesie
  - Chcesz debugować niepowodzenia ładowania wtyczek
title: "wtyczki"
---

# `openclaw plugins`

Zarządzaj wtyczkami/rozszerzeniami Gateway (ładowanymi w procesie).

Powiązane:

- System wtyczek: [Plugins](/tools/plugin)
- Manifest wtyczki + schemat: [Plugin manifest](/plugins/manifest)
- Utwardzanie bezpieczeństwa: [Security](/gateway/security)

## Polecenia

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

Dołączone wtyczki są dostarczane z OpenClaw, ale startują jako wyłączone. Użyj `plugins enable`, aby
je aktywować.

Wszystkie wtyczki muszą dostarczać plik `openclaw.plugin.json` z osadzonym schematem JSON
(`configSchema`, nawet jeśli pusty). Brakujące lub nieprawidłowe manifesty albo schematy
uniemożliwiają załadowanie wtyczki i powodują niepowodzenie walidacji konfiguracji.

### Instalacja

```bash
openclaw plugins install <path-or-spec>
```

Uwaga dotycząca bezpieczeństwa: traktuj instalacje wtyczek jak uruchamianie kodu. Preferuj przypięte wersje.

Obsługiwane archiwa: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Użyj `--link`, aby uniknąć kopiowania lokalnego katalogu (dodaje do `plugins.load.paths`):

```bash
openclaw plugins install -l ./my-plugin
```

### Aktualizacja

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

Aktualizacje dotyczą wyłącznie wtyczek zainstalowanych z npm (śledzonych w `plugins.installs`).
