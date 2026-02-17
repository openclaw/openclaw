---
summary: "Ritual de inicialización del agente que crea los archivos del espacio de trabajo e identidad"
read_when:
  - Entendiendo qué sucede en la primera ejecución del agente
  - Explicando dónde viven los archivos de inicialización
  - Depurando la configuración de identidad de incorporación
title: "Inicialización del Agente"
sidebarTitle: "Inicialización"
---

# Inicialización del Agente

La inicialización es el ritual de **primera ejecución** que prepara un espacio de trabajo del agente y
recopila detalles de identidad. Ocurre después de la incorporación, cuando el agente se inicia
por primera vez.

## Qué hace la inicialización

En la primera ejecución del agente, OpenClaw inicializa el espacio de trabajo (predeterminado
`~/.openclaw/workspace`):

- Crea `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- Ejecuta un ritual breve de preguntas y respuestas (una pregunta a la vez).
- Escribe identidad + preferencias en `IDENTITY.md`, `USER.md`, `SOUL.md`.
- Elimina `BOOTSTRAP.md` cuando termina para que solo se ejecute una vez.

## Dónde se ejecuta

La inicialización siempre se ejecuta en el **host del gateway**. Si la app macOS se conecta a
un Gateway remoto, el espacio de trabajo y los archivos de inicialización viven en esa máquina
remota.

<Note>
Cuando el Gateway se ejecuta en otra máquina, edita los archivos del espacio de trabajo en el host
del gateway (por ejemplo, `user@gateway-host:~/.openclaw/workspace`).
</Note>

## Documentación relacionada

- Incorporación de la app macOS: [Incorporación](/start/onboarding)
- Diseño del espacio de trabajo: [Espacio de trabajo del agente](/concepts/agent-workspace)
