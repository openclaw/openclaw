---
summary: "Capacidades de OpenClaw a través de canales, enrutamiento, medios y UX."
read_when:
  - Quieres una lista completa de lo que soporta OpenClaw
title: "Características"
---

## Destacados

<Columns>
  <Card title="Canales" icon="message-square">
    WhatsApp, Telegram, Discord e iMessage con un único Gateway.
  </Card>
  <Card title="Plugins" icon="plug">
    Agrega Mattermost y más con extensiones.
  </Card>
  <Card title="Enrutamiento" icon="route">
    Enrutamiento multi-agente con sesiones aisladas.
  </Card>
  <Card title="Medios" icon="image">
    Imágenes, audio y documentos entrantes y salientes.
  </Card>
  <Card title="Apps e interfaz" icon="monitor">
    Interfaz de Control Web y aplicación complementaria para macOS.
  </Card>
  <Card title="Nodos móviles" icon="smartphone">
    Nodos iOS y Android con soporte Canvas.
  </Card>
</Columns>

## Lista completa

- Integración de WhatsApp vía WhatsApp Web (Baileys)
- Soporte de bot de Telegram (grammY)
- Soporte de bot de Discord (channels.discord.js)
- Soporte de bot de Mattermost (plugin)
- Integración de iMessage vía CLI imsg local (macOS)
- Puente de agente para Pi en modo RPC con streaming de herramientas
- Streaming y fragmentación para respuestas largas
- Enrutamiento multi-agente para sesiones aisladas por espacio de trabajo o remitente
- Autenticación de suscripción para Anthropic y OpenAI vía OAuth
- Sesiones: los chats directos colapsan en `main` compartido; los grupos están aislados
- Soporte de chat grupal con activación basada en menciones
- Soporte de medios para imágenes, audio y documentos
- Hook de transcripción de notas de voz opcional
- WebChat y aplicación de barra de menú de macOS
- Nodo iOS con emparejamiento y superficie Canvas
- Nodo Android con emparejamiento, Canvas, chat y cámara

<Note>
Los caminos heredados de Claude, Codex, Gemini y Opencode han sido eliminados. Pi es el único
camino de agente de codificación.
</Note>
