---
summary: "Interfaz de Usuario de Terminal (TUI): conéctese al Gateway desde cualquier máquina"
read_when:
  - Quiere una guía paso a paso para principiantes del TUI
  - Necesita la lista completa de funciones, comandos y atajos del TUI
title: "TUI"
---

# TUI (Interfaz de Usuario de Terminal)

## Inicio rápido

1. Inicie el Gateway.

```bash
openclaw gateway
```

2. Abra el TUI.

```bash
openclaw tui
```

3. Escriba un mensaje y presione Enter.

Gateway remoto:

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

Use `--password` si su Gateway usa autenticación por contraseña.

## Lo que ve

- Encabezado: URL de conexión, agente actual, sesión actual.
- Registro de chat: mensajes del usuario, respuestas del asistente, avisos del sistema, tarjetas de herramientas.
- Línea de estado: estado de conexión/ejecución (conectando, en ejecución, streaming, inactivo, error).
- Pie: estado de conexión + agente + sesión + modelo + pensar/detallado/razonamiento + conteos de tokens + entrega.
- Entrada: editor de texto con autocompletado.

## Modelo mental: agentes + sesiones

- Los agentes son identificadores únicos (p. ej., `main`, `research`). El Gateway expone la lista.
- Las sesiones pertenecen al agente actual.
- Las claves de sesión se almacenan como `agent:<agentId>:<sessionKey>`.
  - Si escribe `/session main`, el TUI lo expande a `agent:<currentAgent>:main`.
  - Si escribe `/session agent:other:main`, cambia explícitamente a esa sesión del agente.
- Alcance de la sesión:
  - `per-sender` (predeterminado): cada agente tiene muchas sesiones.
  - `global`: el TUI siempre usa la sesión `global` (el selector puede estar vacío).
- El agente + la sesión actuales siempre son visibles en el pie.

## Envío + entrega

- Los mensajes se envían al Gateway; la entrega a los proveedores está desactivada de forma predeterminada.
- Active la entrega:
  - `/deliver on`
  - o el panel de Configuración
  - o inicie con `openclaw tui --deliver`

## Selectores + superposiciones

- Selector de modelo: enumera los modelos disponibles y establece la anulación de la sesión.
- Selector de agente: elija un agente diferente.
- Selector de sesión: muestra solo las sesiones del agente actual.
- Configuración: alterna la entrega, la expansión de salida de herramientas y la visibilidad del pensamiento.

## Atajos de teclado

- Enter: enviar mensaje
- Esc: abortar la ejecución activa
- Ctrl+C: limpiar la entrada (presione dos veces para salir)
- Ctrl+D: salir
- Ctrl+L: selector de modelo
- Ctrl+G: selector de agente
- Ctrl+P: selector de sesión
- Ctrl+O: alternar la expansión de salida de herramientas
- Ctrl+T: alternar la visibilidad del pensamiento (recarga el historial)

## Comandos con barra

Núcleo:

- `/help`
- `/status`
- `/agent <id>` (o `/agents`)
- `/session <key>` (o `/sessions`)
- `/model <provider/model>` (o `/models`)

Controles de sesión:

- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>` (alias: `/elev`)
- `/activation <mention|always>`
- `/deliver <on|off>`

Ciclo de vida de la sesión:

- `/new` o `/reset` (restablecer la sesión)
- `/abort` (abortar la ejecución activa)
- `/settings`
- `/exit`

Otros comandos con barra del Gateway (por ejemplo, `/context`) se reenvían al Gateway y se muestran como salida del sistema. Consulte [Slash commands](/tools/slash-commands).

## Comandos de shell local

- Anteponer una línea con `!` para ejecutar un comando de shell local en el host del TUI.
- El TUI solicita permiso una vez por sesión para permitir la ejecución local; si lo rechaza, `!` queda deshabilitado para la sesión.
- Los comandos se ejecutan en un shell nuevo y no interactivo en el directorio de trabajo del TUI (sin `cd`/env persistentes).
- Un `!` solo se envía como un mensaje normal; los espacios iniciales no activan la ejecución local.

## Salida de herramientas

- Las llamadas a herramientas se muestran como tarjetas con argumentos + resultados.
- Ctrl+O alterna entre vistas contraída/expandida.
- Mientras se ejecutan las herramientas, las actualizaciones parciales se transmiten en la misma tarjeta.

## Historial + streaming

- Al conectarse, el TUI carga el historial más reciente (200 mensajes por defecto).
- Las respuestas en streaming se actualizan en su lugar hasta finalizar.
- El TUI también escucha eventos de herramientas del agente para tarjetas de herramientas más completas.

## Detalles de conexión

- El TUI se registra con el Gateway como `mode: "tui"`.
- Las reconexiones muestran un mensaje del sistema; las brechas de eventos se reflejan en el registro.

## Opciones

- `--url <url>`: URL del WebSocket del Gateway (predetermina a la configuración o `ws://127.0.0.1:<port>`)
- `--token <token>`: token del Gateway (si es requerido)
- `--password <password>`: contraseña del Gateway (si es requerida)
- `--session <key>`: clave de sesión (predeterminado: `main`, o `global` cuando el alcance es global)
- `--deliver`: entregar las respuestas del asistente al proveedor (desactivado por defecto)
- `--thinking <level>`: anular el nivel de pensamiento para los envíos
- `--timeout-ms <ms>`: tiempo de espera del agente en ms (predetermina a `agents.defaults.timeoutSeconds`)

Nota: cuando establece `--url`, el TUI no recurre a credenciales de configuración ni de entorno.
Pase `--token` o `--password` explícitamente. La falta de credenciales explícitas es un error.

## Solución de problemas

Sin salida después de enviar un mensaje:

- Ejecute `/status` en el TUI para confirmar que el Gateway está conectado y en estado inactivo/ocupado.
- Revise los registros del Gateway: `openclaw logs --follow`.
- Confirme que el agente puede ejecutarse: `openclaw status` y `openclaw models status`.
- Si espera mensajes en un canal de chat, habilite la entrega (`/deliver on` o `--deliver`).
- `--history-limit <n>`: entradas de historial a cargar (predeterminado 200)

## Solución de problemas de conexión

- `disconnected`: asegúrese de que el Gateway esté en ejecución y que sus `--url/--token/--password` sean correctos.
- No hay agentes en el selector: revise `openclaw agents list` y su configuración de enrutamiento.
- Selector de sesión vacío: podría estar en alcance global o aún no tener sesiones.
