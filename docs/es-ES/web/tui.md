---
summary: "Interfaz de terminal (TUI): conéctate al Gateway desde cualquier máquina"
read_when:
  - Quieres un recorrido amigable para principiantes de la TUI
  - Necesitas la lista completa de características, comandos y atajos de la TUI
title: "TUI"
---

# TUI (Interfaz de Terminal)

## Inicio rápido

1. Inicia el Gateway.

```bash
openclaw gateway
```

2. Abre la TUI.

```bash
openclaw tui
```

3. Escribe un mensaje y presiona Enter.

Gateway remoto:

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

Usa `--password` si tu Gateway usa autenticación de contraseña.

## Lo que ves

- Encabezado: URL de conexión, agente actual, sesión actual.
- Registro de chat: mensajes de usuario, respuestas del asistente, avisos del sistema, tarjetas de herramientas.
- Línea de estado: estado de conexión/ejecución (conectando, ejecutando, transmitiendo, inactivo, error).
- Pie de página: estado de conexión + agente + sesión + modelo + pensar/verboso/razonamiento + conteos de tokens + entregar.
- Entrada: editor de texto con autocompletado.

## Modelo mental: agentes + sesiones

- Los agentes son slugs únicos (por ejemplo, `main`, `research`). El Gateway expone la lista.
- Las sesiones pertenecen al agente actual.
- Las claves de sesión se almacenan como `agent:<agentId>:<sessionKey>`.
  - Si escribes `/session main`, la TUI lo expande a `agent:<currentAgent>:main`.
  - Si escribes `/session agent:other:main`, cambias explícitamente a esa sesión de agente.
- Alcance de sesión:
  - `per-sender` (predeterminado): cada agente tiene muchas sesiones.
  - `global`: la TUI siempre usa la sesión `global` (el selector puede estar vacío).
- El agente actual + la sesión siempre son visibles en el pie de página.

## Envío + entrega

- Los mensajes se envían al Gateway; la entrega a proveedores está desactivada por defecto.
- Activar entrega:
  - `/deliver on`
  - o el panel de Configuración
  - o iniciar con `openclaw tui --deliver`

## Selectores + overlays

- Selector de modelo: lista modelos disponibles y establece la anulación de sesión.
- Selector de agente: elige un agente diferente.
- Selector de sesión: muestra solo sesiones para el agente actual.
- Configuración: alternar entrega, expansión de salida de herramientas y visibilidad de pensamiento.

## Atajos de teclado

- Enter: enviar mensaje
- Esc: abortar ejecución activa
- Ctrl+C: limpiar entrada (presiona dos veces para salir)
- Ctrl+D: salir
- Ctrl+L: selector de modelo
- Ctrl+G: selector de agente
- Ctrl+P: selector de sesión
- Ctrl+O: alternar expansión de salida de herramientas
- Ctrl+T: alternar visibilidad de pensamiento (recarga historial)

## Comandos slash

Principales:

- `/help`
- `/status`
- `/agent <id>` (o `/agents`)
- `/session <key>` (o `/sessions`)
- `/model <proveedor/modelo>` (o `/models`)

Controles de sesión:

- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>` (alias: `/elev`)
- `/activation <mention|always>`
- `/deliver <on|off>`

Ciclo de vida de sesión:

- `/new` o `/reset` (reiniciar la sesión)
- `/abort` (abortar la ejecución activa)
- `/settings`
- `/exit`

Otros comandos slash del Gateway (por ejemplo, `/context`) se reenvían al Gateway y se muestran como salida del sistema. Consulta [Comandos slash](/es-ES/tools/slash-commands).

## Comandos de shell local

- Prefija una línea con `!` para ejecutar un comando de shell local en el host de la TUI.
- La TUI solicita una vez por sesión permitir la ejecución local; rechazar mantiene `!` deshabilitado para la sesión.
- Los comandos se ejecutan en un shell nuevo y no interactivo en el directorio de trabajo de la TUI (sin `cd`/env persistente).
- Un `!` solo se envía como un mensaje normal; los espacios iniciales no activan la ejecución local.

## Salida de herramientas

- Las llamadas a herramientas se muestran como tarjetas con args + resultados.
- Ctrl+O alterna entre vistas colapsadas/expandidas.
- Mientras se ejecutan las herramientas, las actualizaciones parciales se transmiten en la misma tarjeta.

## Historial + transmisión

- Al conectarse, la TUI carga el último historial (200 mensajes por defecto).
- Las respuestas de transmisión se actualizan en su lugar hasta finalizarse.
- La TUI también escucha eventos de herramientas de agente para tarjetas de herramientas más ricas.

## Detalles de conexión

- La TUI se registra con el Gateway como `mode: "tui"`.
- Las reconexiones muestran un mensaje del sistema; las brechas de eventos se muestran en el registro.

## Opciones

- `--url <url>`: URL del WebSocket del Gateway (predeterminado a configuración o `ws://127.0.0.1:<port>`)
- `--token <token>`: token del Gateway (si es requerido)
- `--password <password>`: contraseña del Gateway (si es requerida)
- `--session <key>`: clave de sesión (predeterminado: `main`, o `global` cuando el alcance es global)
- `--deliver`: entregar respuestas del asistente al proveedor (desactivado por defecto)
- `--thinking <level>`: anular nivel de pensamiento para envíos
- `--timeout-ms <ms>`: tiempo de espera del agente en ms (predeterminado a `agents.defaults.timeoutSeconds`)

Nota: cuando estableces `--url`, la TUI no recurre a credenciales de configuración o entorno.
Pasa `--token` o `--password` explícitamente. Faltar credenciales explícitas es un error.

## Solución de problemas

Sin salida después de enviar un mensaje:

- Ejecuta `/status` en la TUI para confirmar que el Gateway esté conectado e inactivo/ocupado.
- Verifica los registros del Gateway: `openclaw logs --follow`.
- Confirma que el agente pueda ejecutarse: `openclaw status` y `openclaw models status`.
- Si esperas mensajes en un canal de chat, habilita la entrega (`/deliver on` o `--deliver`).
- `--history-limit <n>`: entradas de historial a cargar (200 por defecto)

## Solución de problemas de conexión

- `disconnected`: asegúrate de que el Gateway esté ejecutándose y que tu `--url/--token/--password` sean correctos.
- Sin agentes en el selector: verifica `openclaw agents list` y tu configuración de enrutamiento.
- Selector de sesión vacío: podrías estar en alcance global o no tener sesiones aún.
