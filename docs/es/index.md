---
summary: "OpenClaw es una pasarela multicanal para agentes de IA que funciona en cualquier sistema operativo."
read_when:
  - Estás conociendo OpenClaw por primera vez
title: "OpenClaw"
---

# OpenClaw 🦞

OpenClaw conecta aplicaciones de mensajería (como WhatsApp, Telegram y Discord) con agentes de IA mediante un único Gateway.

## Inicio rápido

<Steps>
  <Step title="Instalar OpenClaw">
    ```bash
    npm install -g openclaw@latest
    ```
  </Step>
  <Step title="Ejecutar onboarding">
    ```bash
    openclaw onboard --install-daemon
    ```
  </Step>
  <Step title="Conectar canales e iniciar Gateway">
    ```bash
    openclaw channels login
    openclaw gateway --port 18789
    ```
  </Step>
</Steps>
