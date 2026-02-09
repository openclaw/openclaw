---
summary: "Plataformas de mensajería a las que OpenClaw puede conectarse"
read_when:
  - Quiere elegir un canal de chat para OpenClaw
  - Necesita una vista rápida de las plataformas de mensajería compatibles
title: "Canales de chat"
---

# Canales de chat

OpenClaw puede hablar con usted en cualquier app de chat que ya use. Cada canal se conecta a través del Gateway.
El texto es compatible en todos; los medios y las reacciones varían según el canal.

## Canales compatibles

- [WhatsApp](/channels/whatsapp) — El más popular; usa Baileys y requiere emparejamiento por QR.
- [Telegram](/channels/telegram) — API de bots vía grammY; admite grupos.
- [Discord](/channels/discord) — API de bots de Discord + Gateway; admite servidores, canales y mensajes directos.
- [Slack](/channels/slack) — SDK Bolt; apps de espacio de trabajo.
- [Feishu](/channels/feishu) — Bot de Feishu/Lark vía WebSocket (plugin, instalado por separado).
- [Google Chat](/channels/googlechat) — App de Google Chat API vía webhook HTTP.
- [Mattermost](/channels/mattermost) — API de bots + WebSocket; canales, grupos y mensajes directos (plugin, instalado por separado).
- [Signal](/channels/signal) — signal-cli; enfocado en la privacidad.
- [BlueBubbles](/channels/bluebubbles) — **Recomendado para iMessage**; usa la API REST del servidor macOS de BlueBubbles con soporte completo de funciones (editar, deshacer envío, efectos, reacciones, gestión de grupos — la edición está actualmente rota en macOS 26 Tahoe).
- [iMessage (legacy)](/channels/imessage) — Integración heredada de macOS vía CLI imsg (obsoleto; use BlueBubbles para nuevas configuraciones).
- [Microsoft Teams](/channels/msteams) — Bot Framework; soporte empresarial (plugin, instalado por separado).
- [LINE](/channels/line) — Bot de la API de mensajería LINE (plugin, instalado por separado).
- [Nextcloud Talk](/channels/nextcloud-talk) — Chat autoalojado vía Nextcloud Talk (plugin, instalado por separado).
- [Matrix](/channels/matrix) — Protocolo Matrix (plugin, instalado por separado).
- [Nostr](/channels/nostr) — Mensajes directos descentralizados vía NIP-04 (plugin, instalado por separado).
- [Tlon](/channels/tlon) — Mensajero basado en Urbit (plugin, instalado por separado).
- [Twitch](/channels/twitch) — Chat de Twitch vía conexión IRC (plugin, instalado por separado).
- [Zalo](/channels/zalo) — API de bots de Zalo; el mensajero popular de Vietnam (plugin, instalado por separado).
- [Zalo Personal](/channels/zalouser) — Cuenta personal de Zalo vía inicio de sesión por QR (plugin, instalado por separado).
- [WebChat](/web/webchat) — Interfaz WebChat del Gateway sobre WebSocket.

## Notas

- Los canales pueden ejecutarse simultáneamente; configure varios y OpenClaw enruta por chat.
- La configuración más rápida suele ser **Telegram** (token de bot simple). WhatsApp requiere emparejamiento por QR y
  almacena más estado en disco.
- El comportamiento de grupos varía según el canal; vea [Grupos](/channels/groups).
- El emparejamiento de mensajes directos y las listas de permitidos se aplican por seguridad; vea [Seguridad](/gateway/security).
- Detalles internos de Telegram: [notas de grammY](/channels/grammy).
- Solución de problemas: [Solución de problemas de canales](/channels/troubleshooting).
- Los proveedores de modelos se documentan por separado; vea [Proveedores de modelos](/providers/models).
