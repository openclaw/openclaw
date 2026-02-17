---
summary: "Cómo se conectan el Gateway, los nodos y el host del canvas."
read_when:
  - Quieres una vista concisa del modelo de red del Gateway
title: "Modelo de red"
---

La mayoría de las operaciones fluyen a través del Gateway (`openclaw gateway`), un único proceso
de larga duración que posee conexiones de canal y el plano de control WebSocket.

## Reglas principales

- Se recomienda un Gateway por host. Es el único proceso permitido para poseer la sesión de WhatsApp Web. Para bots de rescate o aislamiento estricto, ejecuta múltiples gateways con perfiles y puertos aislados. Ver [Múltiples gateways](/es-ES/gateway/multiple-gateways).
- Bucle local primero: el WS del Gateway predeterminado es `ws://127.0.0.1:18789`. El asistente genera un token de gateway por defecto, incluso para bucle local. Para acceso a tailnet, ejecuta `openclaw gateway --bind tailnet --token ...` porque se requieren tokens para enlaces no de bucle local.
- Los nodos se conectan al WS del Gateway sobre LAN, tailnet o SSH según sea necesario. El puente TCP heredado está obsoleto.
- El host del canvas es servido por el servidor HTTP del Gateway en el **mismo puerto** que el Gateway (predeterminado `18789`):
  - `/__openclaw__/canvas/`
  - `/__openclaw__/a2ui/`
    Cuando `gateway.auth` está configurado y el Gateway se enlaza más allá del bucle local, estas rutas están protegidas por la autenticación del Gateway (las solicitudes de bucle local están exentas). Ver [Configuración del Gateway](/es-ES/gateway/configuration) (`canvasHost`, `gateway`).
- El uso remoto es típicamente un túnel SSH o VPN tailnet. Ver [Acceso remoto](/es-ES/gateway/remote) y [Descubrimiento](/es-ES/gateway/discovery).
