---
summary: "Plataformas de mensajería a las que OpenClaw puede conectarse"
read_when:
  - Quieres elegir un canal de chat para OpenClaw
  - Necesitas una vista general rápida de las plataformas de mensajería soportadas
title: "Canales de Chat"
---

# Canales de Chat

OpenClaw puede hablar contigo en cualquier app de chat que ya uses. Cada canal se conecta vía el Gateway.
El texto es soportado en todas partes; medios y reacciones varían por canal.

## Canales soportados

- [WhatsApp](/channels/whatsapp) — Más popular; usa Baileys y requiere emparejamiento QR.
- [Telegram](/channels/telegram) — Bot API vía grammY; soporta grupos.
- [Discord](/channels/discord) — API de Bot de Discord + Gateway; soporta servidores, canales y mensajes directos.
- [IRC](/channels/irc) — Servidores IRC clásicos; canales + mensajes directos con controles de emparejamiento/lista de permitidos.
- [Slack](/channels/slack) — Bolt SDK; apps de espacio de trabajo.
- [Feishu](/channels/feishu) — Bot de Feishu/Lark vía WebSocket (plugin, instalado por separado).
- [Google Chat](/channels/googlechat) — App de API de Google Chat vía webhook HTTP.
- [Mattermost](/channels/mattermost) — API de Bot + WebSocket; canales, grupos, mensajes directos (plugin, instalado por separado).
- [Signal](/channels/signal) — signal-cli; enfocado en privacidad.
- [BlueBubbles](/channels/bluebubbles) — **Recomendado para iMessage**; usa la API REST del servidor macOS BlueBubbles con soporte completo de características (editar, deshacer envío, efectos, reacciones, gestión de grupos — editar actualmente roto en macOS 26 Tahoe).
- [iMessage (heredado)](/channels/imessage) — Integración heredada de macOS vía imsg CLI (obsoleto, usa BlueBubbles para nuevas configuraciones).
- [Microsoft Teams](/channels/msteams) — Bot Framework; soporte empresarial (plugin, instalado por separado).
- [LINE](/channels/line) — Bot de API de Mensajería LINE (plugin, instalado por separado).
- [Nextcloud Talk](/channels/nextcloud-talk) — Chat auto-alojado vía Nextcloud Talk (plugin, instalado por separado).
- [Matrix](/channels/matrix) — Protocolo Matrix (plugin, instalado por separado).
- [Nostr](/channels/nostr) — Mensajes directos descentralizados vía NIP-04 (plugin, instalado por separado).
- [Tlon](/channels/tlon) — Mensajero basado en Urbit (plugin, instalado por separado).
- [Twitch](/channels/twitch) — Chat de Twitch vía conexión IRC (plugin, instalado por separado).
- [Zalo](/channels/zalo) — API de Bot Zalo; mensajero popular de Vietnam (plugin, instalado por separado).
- [Zalo Personal](/channels/zalouser) — Cuenta personal de Zalo vía login QR (plugin, instalado por separado).
- [WebChat](/web/webchat) — UI WebChat del Gateway sobre WebSocket.

## Notas

- Los canales pueden ejecutarse simultáneamente; configura múltiples y OpenClaw enrutará por chat.
- La configuración más rápida suele ser **Telegram** (simple token de bot). WhatsApp requiere emparejamiento QR y
  almacena más estado en disco.
- El comportamiento de grupos varía por canal; consulta [Grupos](/channels/groups).
- El emparejamiento de mensajes directos y las listas de permitidos se aplican por seguridad; consulta [Seguridad](/gateway/security).
- Internos de Telegram: [notas de grammY](/channels/grammy).
- Solución de problemas: [Solución de problemas de canales](/channels/troubleshooting).
- Los proveedores de modelos están documentados por separado; consulta [Proveedores de Modelos](/providers/models).
