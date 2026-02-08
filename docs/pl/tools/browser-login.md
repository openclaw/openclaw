---
summary: „Ręczne logowania do automatyzacji przeglądarki + publikowanie na X/Twitter”
read_when:
  - Musisz logować się do serwisów na potrzeby automatyzacji przeglądarki
  - Chcesz publikować aktualizacje na X/Twitter
title: „Logowanie w przeglądarce”
x-i18n:
  source_path: tools/browser-login.md
  source_hash: c30faa9da6c6ef70
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:42Z
---

# Logowanie w przeglądarce + publikowanie na X/Twitter

## Ręczne logowanie (zalecane)

Gdy witryna wymaga logowania, **zaloguj się ręcznie** w profilu przeglądarki **hosta** (przeglądarka OpenClaw).

**Nie** przekazuj modelowi swoich danych uwierzytelniających. Zautomatyzowane logowania często uruchamiają mechanizmy anty‑botowe i mogą zablokować konto.

Powrót do głównej dokumentacji przeglądarki: [Browser](/tools/browser).

## Który profil Chrome jest używany?

OpenClaw steruje **dedykowanym profilem Chrome** (o nazwie `openclaw`, interfejs z pomarańczowym odcieniem). Jest on oddzielony od Twojego codziennego profilu przeglądarki.

Dwa proste sposoby uzyskania do niego dostępu:

1. **Poproś agenta o otwarcie przeglądarki**, a następnie zaloguj się samodzielnie.
2. **Otwórz go przez CLI**:

```bash
openclaw browser start
openclaw browser open https://x.com
```

Jeśli masz wiele profili, przekaż `--browser-profile <name>` (domyślnie jest to `openclaw`).

## X/Twitter: zalecany przepływ

- **Czytanie/wyszukiwanie/wątki:** używaj przeglądarki **hosta** (ręczne logowanie).
- **Publikowanie aktualizacji:** używaj przeglądarki **hosta** (ręczne logowanie).

## Sandboxing + dostęp do przeglądarki hosta

Sesje przeglądarki w sandbox są **bardziej narażone** na uruchomienie wykrywania botów. W przypadku X/Twitter (i innych restrykcyjnych serwisów) preferuj przeglądarkę **hosta**.

Jeśli agent działa w sandbox, narzędzie przeglądarki domyślnie korzysta z sandbox. Aby zezwolić na kontrolę hosta:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Następnie wskaż przeglądarkę hosta:

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

Alternatywnie wyłącz sandboxing dla agenta, który publikuje aktualizacje.
