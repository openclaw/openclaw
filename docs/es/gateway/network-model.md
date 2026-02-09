---
summary: "Cómo se conectan el Gateway, los nodos y el host del canvas."
read_when:
  - Quiere una vista concisa del modelo de red del Gateway
title: "Modelo de red"
---

La mayoría de las operaciones fluyen a través del Gateway (`openclaw gateway`), un único
proceso de larga duración que posee las conexiones de canales y el plano de control WebSocket.

## Reglas principales

- Se recomienda un Gateway por host. Es el único proceso autorizado a poseer la sesión de WhatsApp Web. Para bots de rescate o aislamiento estricto, ejecute múltiples Gateways con perfiles y puertos aislados. Consulte [Multiple gateways](/gateway/multiple-gateways).
- Loopback primero: el WS del Gateway usa de forma predeterminada `ws://127.0.0.1:18789`. El asistente genera un token del Gateway de manera predeterminada, incluso para loopback. Para acceso por tailnet, ejecute `openclaw gateway --bind tailnet --token ...` porque los tokens son obligatorios para enlaces que no sean loopback.
- Los nodos se conectan al WS del Gateway por LAN, tailnet o SSH según sea necesario. El puente TCP heredado está obsoleto.
- El host del canvas es un servidor de archivos HTTP en `canvasHost.port` (predeterminado `18793`) que sirve `/__openclaw__/canvas/` para las WebViews de los nodos. Consulte [Gateway configuration](/gateway/configuration) (`canvasHost`).
- El uso remoto suele ser mediante túnel SSH o VPN de tailnet. Consulte [Remote access](/gateway/remote) y [Discovery](/gateway/discovery).
