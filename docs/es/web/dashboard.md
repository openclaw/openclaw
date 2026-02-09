---
summary: "Acceso y autenticación del dashboard del Gateway (UI de control)"
read_when:
  - Cambiar la autenticación del dashboard o los modos de exposición
title: "Dashboard"
---

# Dashboard (UI de control)

El dashboard del Gateway es la UI de control en el navegador que se sirve en `/` de forma predeterminada
(se puede sobrescribir con `gateway.controlUi.basePath`).

Apertura rápida (Gateway local):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (o [http://localhost:18789/](http://localhost:18789/))

Referencias clave:

- [UI de control](/web/control-ui) para el uso y las capacidades de la UI.
- [Tailscale](/gateway/tailscale) para la automatización de Serve/Funnel.
- [Superficies web](/web) para los modos de enlace y notas de seguridad.

La autenticación se aplica en el handshake de WebSocket mediante `connect.params.auth`
(token o contraseña). Consulte `gateway.auth` en [Configuración del Gateway](/gateway/configuration).

Nota de seguridad: la UI de control es una **superficie de administración** (chat, configuración, aprobaciones de ejecución).
No la exponga públicamente. La UI almacena el token en `localStorage` después de la primera carga.
Prefiera localhost, Tailscale Serve o un túnel SSH.

## Ruta rápida (recomendada)

- Después del onboarding, la CLI abre automáticamente el dashboard e imprime un enlace limpio (sin token).
- Reabrir en cualquier momento: `openclaw dashboard` (copia el enlace, abre el navegador si es posible y muestra una sugerencia de SSH si está en modo headless).
- Si la UI solicita autenticación, pegue el token de `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`) en la configuración de la UI de control.

## Conceptos básicos de tokens (local vs remoto)

- **Localhost**: abra `http://127.0.0.1:18789/`.
- **Origen del token**: `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`); la UI almacena una copia en localStorage después de conectarse.
- **No localhost**: use Tailscale Serve (sin token si `gateway.auth.allowTailscale: true`), enlace del tailnet con un token, o un túnel SSH. Consulte [Superficies web](/web).

## Si ve “unauthorized” / 1008

- Asegúrese de que el gateway sea alcanzable (local: `openclaw status`; remoto: túnel SSH `ssh -N -L 18789:127.0.0.1:18789 user@host` y luego abra `http://127.0.0.1:18789/`).
- Recupere el token del host del Gateway: `openclaw config get gateway.auth.token` (o genere uno: `openclaw doctor --generate-gateway-token`).
- En la configuración del dashboard, pegue el token en el campo de autenticación y luego conéctese.
