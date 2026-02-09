---
summary: "Use o OAuth do Qwen (camada gratuita) no OpenClaw"
read_when:
  - Você quer usar o Qwen com o OpenClaw
  - Você quer acesso OAuth gratuito ao Qwen Coder
title: "Qwen"
---

# Qwen

O Qwen oferece um fluxo OAuth de camada gratuita para os modelos Qwen Coder e Qwen Vision
(2.000 requisições/dia, sujeito aos limites de taxa do Qwen).

## Habilitar o plugin

```bash
openclaw plugins enable qwen-portal-auth
```

Reinicie o Gateway após habilitar.

## Autenticar

```bash
openclaw models auth login --provider qwen-portal --set-default
```

Isso executa o fluxo OAuth de código de dispositivo do Qwen e grava uma entrada de provedor no seu
`models.json` (além de um alias `qwen` para troca rápida).

## IDs de modelo

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Alterne os modelos com:

```bash
openclaw models set qwen-portal/coder-model
```

## Reutilizar login do Qwen Code CLI

Se você já fez login com o Qwen Code CLI, o OpenClaw irá sincronizar as credenciais
de `~/.qwen/oauth_creds.json` quando carregar o armazenamento de autenticação. Você ainda precisa de uma
entrada `models.providers.qwen-portal` (use o comando de login acima para criar uma).

## Notas

- Os tokens são renovados automaticamente; execute novamente o comando de login se a renovação falhar ou se o acesso for revogado.
- URL base padrão: `https://portal.qwen.ai/v1` (substitua com
  `models.providers.qwen-portal.baseUrl` se o Qwen fornecer um endpoint diferente).
- Veja [Model providers](/concepts/model-providers) para regras aplicáveis a todos os provedores.
