---
summary: "Ejecuciones directas de la CLI `openclaw agent` (con entrega opcional)"
read_when:
  - Al agregar o modificar el punto de entrada de la CLI del agente
title: "Envío del agente"
---

# `openclaw agent` (ejecuciones directas del agente)

`openclaw agent` ejecuta un solo turno del agente sin necesitar un mensaje de chat entrante.
De forma predeterminada pasa **por el Gateway**; agregue `--local` para forzar el runtime
integrado en la máquina actual.

## Comportamiento

- Requerido: `--message <text>`
- Selección de sesión:
  - `--to <dest>` deriva la clave de sesión (los destinos de grupo/canal preservan el aislamiento; los chats directos se consolidan en `main`), **o**
  - `--session-id <id>` reutiliza una sesión existente por id, **o**
  - `--agent <id>` apunta directamente a un agente configurado (usa la clave de sesión `main` de ese agente)
- Ejecuta el mismo runtime de agente integrado que las respuestas entrantes normales.
- Los flags de thinking/verbose persisten en el almacén de sesiones.
- Salida:
  - predeterminado: imprime el texto de respuesta (más líneas `MEDIA:<url>`)
  - `--json`: imprime la carga útil estructurada + metadatos
- Entrega opcional de vuelta a un canal con `--deliver` + `--channel` (los formatos de destino coinciden con `openclaw message --target`).
- Use `--reply-channel`/`--reply-to`/`--reply-account` para anular la entrega sin cambiar la sesión.

Si el Gateway no está disponible, la CLI **hace fallback** a la ejecución local integrada.

## Ejemplos

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## Flags

- `--local`: ejecutar localmente (requiere claves de API del proveedor de modelos en su shell)
- `--deliver`: enviar la respuesta al canal elegido
- `--channel`: canal de entrega (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, predeterminado: `whatsapp`)
- `--reply-to`: anulación del destino de entrega
- `--reply-channel`: anulación del canal de entrega
- `--reply-account`: anulación del id de la cuenta de entrega
- `--thinking <off|minimal|low|medium|high|xhigh>`: persistir el nivel de thinking (solo modelos GPT-5.2 + Codex)
- `--verbose <on|full|off>`: persistir el nivel verbose
- `--timeout <seconds>`: anular el tiempo de espera del agente
- `--json`: salida JSON estructurada
