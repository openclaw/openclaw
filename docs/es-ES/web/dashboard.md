---
summary: "Acceso y autenticación del panel de control del Gateway (Interfaz de Control)"
read_when:
  - Cambias la autenticación del panel de control o los modos de exposición
title: "Panel de control"
---

# Panel de control (Interfaz de Control)

El panel de control del Gateway es la Interfaz de Control del navegador servida en `/` por defecto
(anula con `gateway.controlUi.basePath`).

Apertura rápida (Gateway local):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (o [http://localhost:18789/](http://localhost:18789/))

Referencias clave:

- [Interfaz de Control](/es-ES/web/control-ui) para uso y capacidades de la interfaz.
- [Tailscale](/es-ES/gateway/tailscale) para automatización Serve/Funnel.
- [Superficies web](/es-ES/web) para modos de enlace y notas de seguridad.

La autenticación se aplica en el handshake del WebSocket mediante `connect.params.auth`
(token o contraseña). Consulta `gateway.auth` en [Configuración del Gateway](/es-ES/gateway/configuration).

Nota de seguridad: la Interfaz de Control es una **superficie de administración** (chat, configuración, aprobaciones de ejecución).
No la expongas públicamente. La interfaz almacena el token en `localStorage` después de la primera carga.
Prefiere localhost, Tailscale Serve o un túnel SSH.

## Ruta rápida (recomendado)

- Después de la incorporación, el CLI abre automáticamente el panel de control e imprime un enlace limpio (sin token).
- Vuelve a abrir en cualquier momento: `openclaw dashboard` (copia el enlace, abre el navegador si es posible, muestra sugerencia SSH si no hay interfaz gráfica).
- Si la interfaz solicita autenticación, pega el token de `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`) en la configuración de la Interfaz de Control.

## Conceptos básicos de token (local vs remoto)

- **Localhost**: abre `http://127.0.0.1:18789/`.
- **Fuente de token**: `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`); la interfaz almacena una copia en localStorage después de conectarte.
- **No localhost**: usa Tailscale Serve (sin token si `gateway.auth.allowTailscale: true`), bind de tailnet con un token, o un túnel SSH. Consulta [Superficies web](/es-ES/web).

## Si ves "unauthorized" / 1008

- Asegúrate de que el gateway sea accesible (local: `openclaw status`; remoto: túnel SSH `ssh -N -L 18789:127.0.0.1:18789 user@host` luego abre `http://127.0.0.1:18789/`).
- Recupera el token del host del gateway: `openclaw config get gateway.auth.token` (o genera uno: `openclaw doctor --generate-gateway-token`).
- En la configuración del panel de control, pega el token en el campo de autenticación, luego conéctate.
