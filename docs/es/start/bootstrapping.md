---
summary: "Ritual de arranque del agente que inicializa el espacio de trabajo y los archivos de identidad"
read_when:
  - Comprender qué sucede en la primera ejecución del agente
  - Explicar dónde viven los archivos de arranque
  - Depurar la configuración de identidad durante la incorporación
title: "Arranque del agente"
sidebarTitle: "Bootstrapping"
x-i18n:
  source_path: start/bootstrapping.md
  source_hash: 4a08b5102f25c6c4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:34:35Z
---

# Arranque del agente

El arranque es el ritual de **primera ejecución** que prepara el espacio de trabajo de un agente y
recopila los detalles de identidad. Ocurre después de la incorporación, cuando el agente se inicia
por primera vez.

## Qué hace el arranque

En la primera ejecución del agente, OpenClaw inicializa el espacio de trabajo (predeterminado
`~/.openclaw/workspace`):

- Inicializa `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- Ejecuta un breve ritual de preguntas y respuestas (una pregunta a la vez).
- Escribe la identidad y las preferencias en `IDENTITY.md`, `USER.md`, `SOUL.md`.
- Elimina `BOOTSTRAP.md` al finalizar para que solo se ejecute una vez.

## Dónde se ejecuta

El arranque siempre se ejecuta en el **host del Gateway**. Si la app de macOS se conecta a
un Gateway remoto, el espacio de trabajo y los archivos de arranque viven en esa
máquina remota.

<Note>
Cuando el Gateway se ejecuta en otra máquina, edite los archivos del espacio de trabajo en el host del Gateway
(por ejemplo, `user@gateway-host:~/.openclaw/workspace`).
</Note>

## Documentos relacionados

- Incorporación de la app de macOS: [Onboarding](/start/onboarding)
- Diseño del espacio de trabajo: [Agent workspace](/concepts/agent-workpace)
