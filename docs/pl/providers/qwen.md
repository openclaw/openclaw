---
summary: "„Użyj OAuth Qwen (warstwa darmowa) w OpenClaw”"
read_when:
  - Chcesz używać Qwen z OpenClaw
  - Chcesz uzyskać dostęp OAuth do Qwen Coder w warstwie darmowej
title: "Qwen"
---

# Qwen

Qwen zapewnia przepływ OAuth w warstwie darmowej dla modeli Qwen Coder i Qwen Vision
(2 000 żądań dziennie, z zastrzeżeniem limitów Qwen).

## Włącz wtyczkę

```bash
openclaw plugins enable qwen-portal-auth
```

Po włączeniu uruchom ponownie Gateway.

## Uwierzytelnianie

```bash
openclaw models auth login --provider qwen-portal --set-default
```

To uruchamia przepływ OAuth z kodem urządzenia Qwen i zapisuje wpis dostawcy w
`models.json` (oraz alias `qwen` do szybkiego przełączania).

## Identyfikatory modeli

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Przełączanie modeli:

```bash
openclaw models set qwen-portal/coder-model
```

## Ponowne użycie logowania Qwen Code CLI

Jeśli wcześniej zalogowano się za pomocą Qwen Code CLI, OpenClaw zsynchronizuje poświadczenia
z `~/.qwen/oauth_creds.json` podczas ładowania magazynu uwierzytelniania. Nadal wymagany jest wpis
`models.providers.qwen-portal` (użyj powyższego polecenia logowania, aby go utworzyć).

## Uwagi

- Tokeny są automatycznie odświeżane; uruchom ponownie polecenie logowania, jeśli odświeżanie się nie powiedzie lub dostęp zostanie cofnięty.
- Domyślny adres URL bazy: `https://portal.qwen.ai/v1` (zastąp go
  `models.providers.qwen-portal.baseUrl`, jeśli Qwen udostępni inny punkt końcowy).
- Zobacz [Dostawcy modeli](/concepts/model-providers), aby poznać zasady obowiązujące dla całego dostawcy.
