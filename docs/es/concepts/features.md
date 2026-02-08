---
summary: "Capacidades de OpenClaw en canales, enrutamiento, medios y UX."
read_when:
  - Desea una lista completa de lo que admite OpenClaw
title: "Características"
x-i18n:
  source_path: concepts/features.md
  source_hash: 1b6aee0bfda75182
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:33:09Z
---

## Destacados

<Columns>
  <Card title="Canales" icon="message-square">
    WhatsApp, Telegram, Discord e iMessage con un solo Gateway.
  </Card>
  <Card title="Plugins" icon="plug">
    Agregue Mattermost y más con extensiones.
  </Card>
  <Card title="Enrutamiento" icon="route">
    Enrutamiento multiagente con sesiones aisladas.
  </Card>
  <Card title="Medios" icon="image">
    Imágenes, audio y documentos de entrada y salida.
  </Card>
  <Card title="Apps y UI" icon="monitor">
    Web Control UI y aplicación complementaria de macOS.
  </Card>
  <Card title="Nodos móviles" icon="smartphone">
    Nodos iOS y Android con soporte de Canvas.
  </Card>
</Columns>

## Lista completa

- Integración con WhatsApp vía WhatsApp Web (Baileys)
- Soporte de bot de Telegram (grammY)
- Soporte de bot de Discord (channels.discord.js)
- Soporte de bot de Mattermost (plugin)
- Integración de iMessage vía CLI local imsg (macOS)
- Puente de agente para Pi en modo RPC con streaming de herramientas
- Streaming y fragmentación para respuestas largas
- Enrutamiento multiagente para sesiones aisladas por espacio de trabajo o remitente
- Autenticación por suscripción para Anthropic y OpenAI vía OAuth
- Sesiones: los chats directos se consolidan en `main`; los grupos están aislados
- Soporte de chat grupal con activación basada en menciones
- Soporte de medios para imágenes, audio y documentos
- Gancho opcional de transcripción de notas de voz
- WebChat y app de la barra de menús de macOS
- Nodo iOS con emparejamiento y superficie Canvas
- Nodo Android con emparejamiento, Canvas, chat y cámara

<Note>
Se han eliminado las rutas heredadas de Claude, Codex, Gemini y Opencode. Pi es la única
ruta de agente de codificación.
</Note>
