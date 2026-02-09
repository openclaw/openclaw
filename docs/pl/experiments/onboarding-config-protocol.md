---
summary: "Uwagi dotyczące protokołu RPC dla kreatora onboardingu i schematu konfiguracji"
read_when: "Zmiana kroków kreatora onboardingu lub punktów końcowych schematu konfiguracji"
title: "Onboarding i protokół konfiguracji"
---

# Onboarding + protokół konfiguracji

Cel: współdzielone powierzchnie onboardingu i konfiguracji w CLI, aplikacji na macOS oraz interfejsie Web UI.

## Komponenty

- Silnik kreatora (wspólna sesja + monity + stan onboardingu).
- Onboarding w CLI korzysta z tego samego przepływu kreatora co klienci UI.
- RPC Gateway udostępnia punkty końcowe kreatora oraz schematu konfiguracji.
- Onboarding na macOS używa modelu kroków kreatora.
- Web UI renderuje formularze konfiguracji na podstawie JSON Schema + wskazówek UI.

## RPC Gateway

- `wizard.start` params: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` params: `{ sessionId }`
- `wizard.status` params: `{ sessionId }`
- `config.schema` params: `{}`

Odpowiedzi (kształt)

- Kreator: `{ sessionId, done, step?, status?, error? }`
- Schemat konfiguracji: `{ schema, uiHints, version, generatedAt }`

## Wskazówki UI

- `uiHints` kluczowane według ścieżki; opcjonalne metadane (etykieta/pomoc/grupa/kolejność/zaawansowane/wrażliwe/placeholder).
- Pola wrażliwe są renderowane jako pola hasła; brak warstwy redakcji.
- Nieobsługiwane węzły schematu przechodzą do surowego edytora JSON.

## Uwagi

- Ten dokument jest jedynym miejscem do śledzenia refaktoryzacji protokołu dla onboardingu/konfiguracji.
