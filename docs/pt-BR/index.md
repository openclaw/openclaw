---
summary: "OpenClaw é um gateway multicanal para agentes de IA que funciona em qualquer sistema operacional."
read_when:
  - Você está conhecendo o OpenClaw pela primeira vez
title: "OpenClaw"
---

# OpenClaw 🦞

OpenClaw conecta apps de conversa (como WhatsApp, Telegram e Discord) a agentes de IA por meio de um único Gateway.

## Início rápido

<Steps>
  <Step title="Instalar o OpenClaw">
    ```bash
    npm install -g openclaw@latest
    ```
  </Step>
  <Step title="Executar onboarding">
    ```bash
    openclaw onboard --install-daemon
    ```
  </Step>
  <Step title="Conectar canais e iniciar o Gateway">
    ```bash
    openclaw channels login
    openclaw gateway --port 18789
    ```
  </Step>
</Steps>

## Próximos passos

- [Primeiros passos](/start/getting-started)
- [Assistente de onboarding](/start/wizard)
- [Canais](/channels/index)
- [Configuração do Gateway](/gateway/configuration)
- [Solução de problemas](/gateway/troubleshooting)

> Observação: a tradução completa para pt-BR está em andamento. Enquanto isso, as páginas acima levam para a documentação principal.
