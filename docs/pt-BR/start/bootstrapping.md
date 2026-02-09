---
summary: "Ritual de inicialização do agente que prepara o workspace e os arquivos de identidade"
read_when:
  - Entender o que acontece na primeira execução do agente
  - Explicar onde ficam os arquivos de bootstrapping
  - Configuração de identidade de depuração
title: "Bootstrapping do Agente"
sidebarTitle: "Bootstrapping"
---

# Bootstrapping do Agente

Bootstrapping é o ritual de **primeira execução** que prepara o workspace do agente e
coleta detalhes de identidade. Ele acontece após a integração inicial, quando o agente inicia
pela primeira vez.

## O que o bootstrapping faz

Na primeira execução do agente, o OpenClaw inicializa o workspace (padrão
`~/.openclaw/workspace`):

- Preenche `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- Executa um breve ritual de perguntas e respostas (uma pergunta por vez).
- Grava identidade + preferências em `IDENTITY.md`, `USER.md`, `SOUL.md`.
- Remove `BOOTSTRAP.md` ao finalizar, para que seja executado apenas uma vez.

## Onde ele é executado

O bootstrapping sempre é executado no **host do gateway**. Se o app do macOS se conectar a
um Gateway remoto, o workspace e os arquivos de bootstrapping ficam nessa
máquina remota.

<Note>
Quando o Gateway é executado em outra máquina, edite os arquivos do workspace no host do gateway
(por exemplo, `user@gateway-host:~/.openclaw/workspace`).
</Note>

## Documentos relacionados

- Integração inicial do app do macOS: [Onboarding](/start/onboarding)
- Layout do workspace: [Agent workspace](/concepts/agent-workspace)
