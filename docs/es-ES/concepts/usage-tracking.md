---
summary: "Superficies de seguimiento de uso y requisitos de credenciales"
read_when:
  - Estás conectando superficies de uso/cuota del proveedor
  - Necesitas explicar el comportamiento del seguimiento de uso o requisitos de autenticación
title: "Seguimiento de Uso"
---

# Seguimiento de uso

## Qué es

- Obtiene el uso/cuota del proveedor directamente desde sus endpoints de uso.
- Sin costos estimados; solo las ventanas reportadas por el proveedor.

## Dónde aparece

- `/status` en chats: tarjeta de estado rica en emojis con tokens de sesión + costo estimado (solo clave API). El uso del proveedor se muestra para el **proveedor de modelo actual** cuando está disponible.
- `/usage off|tokens|full` en chats: pie de uso por respuesta (OAuth muestra solo tokens).
- `/usage cost` en chats: resumen de costo local agregado desde los registros de sesión de OpenClaw.
- CLI: `openclaw status --usage` imprime un desglose completo por proveedor.
- CLI: `openclaw channels list` imprime la misma instantánea de uso junto con la configuración del proveedor (usa `--no-usage` para omitir).
- Barra de menú macOS: sección "Usage" bajo Context (solo si está disponible).

## Proveedores + credenciales

- **Anthropic (Claude)**: tokens OAuth en perfiles de autenticación.
- **GitHub Copilot**: tokens OAuth en perfiles de autenticación.
- **Gemini CLI**: tokens OAuth en perfiles de autenticación.
- **Antigravity**: tokens OAuth en perfiles de autenticación.
- **OpenAI Codex**: tokens OAuth en perfiles de autenticación (accountId usado cuando está presente).
- **MiniMax**: clave API (clave de plan de codificación; `MINIMAX_CODE_PLAN_KEY` o `MINIMAX_API_KEY`); usa la ventana de plan de codificación de 5 horas.
- **z.ai**: clave API vía env/config/almacén de autenticación.

El uso está oculto si no existen credenciales OAuth/API coincidentes.
