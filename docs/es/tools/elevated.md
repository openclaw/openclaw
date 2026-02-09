---
summary: "Modo de ejecución elevado y directivas /elevated"
read_when:
  - Ajustar los valores predeterminados del modo elevado, las listas de permitidos o el comportamiento de los comandos con barra
title: "Modo Elevado"
---

# Modo Elevado (/elevated directives)

## Qué hace

- `/elevated on` se ejecuta en el host del Gateway y mantiene las aprobaciones de exec (igual que `/elevated ask`).
- `/elevated full` se ejecuta en el host del Gateway **y** aprueba automáticamente exec (omite las aprobaciones de exec).
- `/elevated ask` se ejecuta en el host del Gateway pero mantiene las aprobaciones de exec (igual que `/elevated on`).
- `on`/`ask` **no** fuerzan `exec.security=full`; la política de seguridad/confirmación configurada sigue aplicándose.
- Solo cambia el comportamiento cuando el agente está **en sandbox** (de lo contrario, exec ya se ejecuta en el host).
- Formas de directiva: `/elevated on|off|ask|full`, `/elev on|off|ask|full`.
- Solo se aceptan `on|off|ask|full`; cualquier otra cosa devuelve una sugerencia y no cambia el estado.

## Qué controla (y qué no)

- **Puertas de disponibilidad**: `tools.elevated` es la línea base global. `agents.list[].tools.elevated` puede restringir aún más el modo elevado por agente (ambos deben permitir).
- **Estado por sesión**: `/elevated on|off|ask|full` establece el nivel elevado para la clave de sesión actual.
- **Directiva en línea**: `/elevated on|ask|full` dentro de un mensaje se aplica solo a ese mensaje.
- **Grupos**: En chats grupales, las directivas elevadas solo se respetan cuando se menciona al agente. Los mensajes solo de comando que omiten el requisito de mención se tratan como mencionados.
- **Ejecución en el host**: el modo elevado fuerza `exec` en el host del Gateway; `full` también establece `security=full`.
- **Aprobaciones**: `full` omite las aprobaciones de exec; `on`/`ask` las respetan cuando las reglas de lista de permitidos/confirmación lo requieren.
- **Agentes no en sandbox**: sin efecto para la ubicación; solo afecta el control, el registro y el estado.
- **La política de herramientas sigue aplicándose**: si `exec` está denegado por la política de herramientas, el modo elevado no puede usarse.
- **Separado de `/exec`**: `/exec` ajusta los valores predeterminados por sesión para remitentes autorizados y no requiere modo elevado.

## Orden de resolución

1. Directiva en línea en el mensaje (se aplica solo a ese mensaje).
2. Anulación de sesión (establecida enviando un mensaje solo con la directiva).
3. Valor predeterminado global (`agents.defaults.elevatedDefault` en la configuración).

## Establecer un valor predeterminado de sesión

- Envíe un mensaje que sea **solo** la directiva (se permiten espacios en blanco), por ejemplo, `/elevated full`.
- Se envía una respuesta de confirmación (`Elevated mode set to full...` / `Elevated mode disabled.`).
- Si el acceso elevado está deshabilitado o el remitente no está en la lista de permitidos aprobada, la directiva responde con un error accionable y no cambia el estado de la sesión.
- Envíe `/elevated` (o `/elevated:`) sin argumento para ver el nivel elevado actual.

## Disponibilidad + listas de permitidos

- Puerta de funcionalidad: `tools.elevated.enabled` (el valor predeterminado puede estar desactivado vía configuración incluso si el código lo admite).
- Lista de permitidos del remitente: `tools.elevated.allowFrom` con listas de permitidos por proveedor (p. ej., `discord`, `whatsapp`).
- Puerta por agente: `agents.list[].tools.elevated.enabled` (opcional; solo puede restringir más).
- Lista de permitidos por agente: `agents.list[].tools.elevated.allowFrom` (opcional; cuando se establece, el remitente debe coincidir con **ambas** listas de permitidos: global + por agente).
- Respaldo de Discord: si se omite `tools.elevated.allowFrom.discord`, se usa la lista `channels.discord.dm.allowFrom` como respaldo. Establezca `tools.elevated.allowFrom.discord` (incluso `[]`) para anular. Las listas de permitidos por agente **no** usan el respaldo.
- Todas las puertas deben aprobar; de lo contrario, el modo elevado se trata como no disponible.

## Registro + estado

- Las llamadas de exec en modo elevado se registran a nivel info.
- El estado de la sesión incluye el modo elevado (p. ej., `elevated=ask`, `elevated=full`).
