---
summary: "Faça login no GitHub Copilot a partir do OpenClaw usando o fluxo de dispositivo"
read_when:
  - Você quer usar o GitHub Copilot como provedor de modelo
  - Você precisa do fluxo `openclaw models auth login-github-copilot`
title: "GitHub Copilot"
---

# GitHub Copilot

## O que é o GitHub Copilot?

O GitHub Copilot é o assistente de programação com IA do GitHub. Ele fornece acesso aos modelos do Copilot para sua conta e plano do GitHub. O OpenClaw pode usar o Copilot como provedor de modelo de duas maneiras diferentes.

## Duas formas de usar o Copilot no OpenClaw

### 1. Provedor GitHub Copilot integrado (`github-copilot`)

Use o fluxo nativo de login por dispositivo para obter um token do GitHub e, em seguida, trocá-lo por tokens da API do Copilot quando o OpenClaw for executado. Este é o caminho **padrão** e mais simples, pois não exige o VS Code.

### 2. Plugin Copilot Proxy (`copilot-proxy`)

Use a extensão **Copilot Proxy** do VS Code como uma ponte local. O OpenClaw se comunica com o endpoint `/v1` do proxy e usa a lista de modelos que você configura lá. Escolha esta opção quando você já executa o Copilot Proxy no VS Code ou precisa rotear por ele.
Você deve habilitar o plugin e manter a extensão do VS Code em execução.

Use o GitHub Copilot como um provedor de modelo (`github-copilot`). O comando de login executa o fluxo de dispositivo do GitHub, salva um perfil de autenticação e atualiza sua configuração para usar esse perfil.

## Configuração da CLI

```bash
openclaw models auth login-github-copilot
```

Você será solicitado a visitar uma URL e inserir um código de uso único. Mantenha o terminal aberto até a conclusão.

### Flags opcionais

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## Definir um modelo padrão

```bash
openclaw models set github-copilot/gpt-4o
```

### Trecho de configuração

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## Notas

- Requer um TTY interativo; execute diretamente em um terminal.
- A disponibilidade dos modelos do Copilot depende do seu plano; se um modelo for rejeitado, tente outro ID (por exemplo, `github-copilot/gpt-4.1`).
- O login armazena um token do GitHub no armazenamento de perfis de autenticação e o troca por um token da API do Copilot quando o OpenClaw é executado.
