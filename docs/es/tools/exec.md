---
summary: "Uso de la herramienta Exec, modos de stdin y compatibilidad con TTY"
read_when:
  - Uso o modificación de la herramienta exec
  - Depuración del comportamiento de stdin o TTY
title: "Herramienta Exec"
---

# Herramienta Exec

Ejecute comandos de shell en el workspace. Admite ejecución en primer plano y en segundo plano mediante `process`.
Si `process` no está permitido, `exec` se ejecuta de forma sincrónica e ignora `yieldMs`/`background`.
Las sesiones en segundo plano tienen alcance por agente; `process` solo ve sesiones del mismo agente.

## Parámetros

- `command` (obligatorio)
- `workdir` (valor predeterminado: cwd)
- `env` (sobrescrituras clave/valor)
- `yieldMs` (predeterminado 10000): pasar automáticamente a segundo plano tras el retraso
- `background` (bool): ejecutar inmediatamente en segundo plano
- `timeout` (segundos, predeterminado 1800): finalizar al expirar
- `pty` (bool): ejecutar en un pseudo-terminal cuando esté disponible (CLIs solo TTY, agentes de codificación, UIs de terminal)
- `host` (`sandbox | gateway | node`): dónde ejecutar
- `security` (`deny | allowlist | full`): modo de aplicación para `gateway`/`node`
- `ask` (`off | on-miss | always`): solicitudes de aprobación para `gateway`/`node`
- `node` (string): id/nombre del nodo para `host=node`
- `elevated` (bool): solicitar modo elevado (host del Gateway); `security=full` solo se fuerza cuando lo elevado se resuelve a `full`

Notas:

- `host` tiene como valor predeterminado `sandbox`.
- `elevated` se ignora cuando sandboxing está desactivado (exec ya se ejecuta en el host).
- Las aprobaciones de `gateway`/`node` están controladas por `~/.openclaw/exec-approvals.json`.
- `node` requiere un nodo emparejado (aplicación complementaria o host de nodo headless).
- Si hay varios nodos disponibles, configure `exec.node` o `tools.exec.node` para seleccionar uno.
- En hosts que no son Windows, exec usa `SHELL` cuando está configurado; si `SHELL` es `fish`, prefiere `bash` (o `sh`)
  de `PATH` para evitar scripts incompatibles con fish, y luego recurre a `SHELL` si ninguno existe.
- La ejecución en el host (`gateway`/`node`) rechaza `env.PATH` y las sobrescrituras del cargador (`LD_*`/`DYLD_*`) para
  evitar el secuestro de binarios o la inyección de código.
- Importante: sandboxing está **desactivado de forma predeterminada**. Si sandboxing está desactivado, `host=sandbox` se ejecuta directamente en
  el host del Gateway (sin contenedor) y **no requiere aprobaciones**. Para exigir aprobaciones, ejecute con
  `host=gateway` y configure las aprobaciones de exec (o habilite sandboxing).

## Configuración

- `tools.exec.notifyOnExit` (predeterminado: true): cuando es true, las sesiones de exec en segundo plano encolan un evento del sistema y solicitan un latido al salir.
- `tools.exec.approvalRunningNoticeMs` (predeterminado: 10000): emite un único aviso de “en ejecución” cuando un exec con aprobación tarda más que esto (0 lo desactiva).
- `tools.exec.host` (predeterminado: `sandbox`)
- `tools.exec.security` (predeterminado: `deny` para sandbox, `allowlist` para gateway + nodo cuando no está configurado)
- `tools.exec.ask` (predeterminado: `on-miss`)
- `tools.exec.node` (predeterminado: sin configurar)
- `tools.exec.pathPrepend`: lista de directorios para anteponer a `PATH` en ejecuciones de exec.
- `tools.exec.safeBins`: binarios seguros solo de stdin que pueden ejecutarse sin entradas explícitas en la lista de permitidos.

Ejemplo:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### Manejo de PATH

- `host=gateway`: fusiona su `PATH` del shell de inicio de sesión en el entorno de exec. Las sobrescrituras de `env.PATH` son
  rechazadas para la ejecución en el host. El daemon en sí sigue ejecutándose con un `PATH` mínimo:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: ejecuta `sh -lc` (shell de inicio de sesión) dentro del contenedor, por lo que `/etc/profile` puede restablecer `PATH`.
  OpenClaw antepone `env.PATH` después de cargar el perfil mediante una variable de entorno interna (sin interpolación del shell);
  `tools.exec.pathPrepend` también aplica aquí.
- `host=node`: solo se envían al nodo las sobrescrituras de entorno no bloqueadas que usted pase. Las sobrescrituras de `env.PATH` son
  rechazadas para la ejecución en el host. Los hosts de nodos headless aceptan `PATH` solo cuando antepone el PATH del host del nodo
  (sin reemplazo). Los nodos macOS descartan por completo las sobrescrituras de `PATH`.

Vinculación de nodo por agente (use el índice de la lista de agentes en la configuración):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

UI de control: la pestaña Nodes incluye un pequeño panel de “Exec node binding” para los mismos ajustes.

## Sobrescrituras de sesión (`/exec`)

Use `/exec` para establecer valores predeterminados **por sesión** para `host`, `security`, `ask` y `node`.
Envíe `/exec` sin argumentos para mostrar los valores actuales.

Ejemplo:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Modelo de autorización

`/exec` solo se respeta para **remitentes autorizados** (listas de permitidos por canal/emparejamiento más `commands.useAccessGroups`).
Actualiza **solo el estado de la sesión** y no escribe configuración. Para deshabilitar exec de forma permanente, deniéguelo mediante la política
de herramientas (`tools.deny: ["exec"]` o por agente). Las aprobaciones del host siguen aplicando a menos que usted establezca explícitamente
`security=full` y `ask=off`.

## Aprobaciones de Exec (aplicación complementaria / host de nodo)

Los agentes en sandbox pueden requerir aprobación por solicitud antes de que `exec` se ejecute en el host del Gateway o del nodo.
Consulte [Exec approvals](/tools/exec-approvals) para la política, la lista de permitidos y el flujo de la UI.

Cuando se requieren aprobaciones, la herramienta exec devuelve inmediatamente
`status: "approval-pending"` y un id de aprobación. Una vez aprobado (o denegado / con tiempo de espera agotado),
el Gateway emite eventos del sistema (`Exec finished` / `Exec denied`). Si el comando sigue
ejecutándose después de `tools.exec.approvalRunningNoticeMs`, se emite un único aviso de `Exec running`.

## Lista de permitidos + binarios seguros

La aplicación de la lista de permitidos coincide **solo con rutas de binarios resueltas** (sin coincidencias por nombre base). Cuando
`security=allowlist`, los comandos de shell se permiten automáticamente solo si cada segmento del pipeline está
en la lista de permitidos o es un binario seguro. El encadenamiento (`;`, `&&`, `||`) y las redirecciones se rechazan en
modo de lista de permitidos.

## Ejemplos

Primer plano:

```json
{ "tool": "exec", "command": "ls -la" }
```

Fondo + encuesta:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

Enviar teclas (estilo tmux):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

Enviar (solo enviar CR):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Pegar (entre corchetes de forma predeterminada):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (experimental)

`apply_patch` es una subherramienta de `exec` para ediciones estructuradas de varios archivos.
Habilítela explícitamente:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

Notas:

- Solo disponible para modelos OpenAI/OpenAI Codex.
- La política de herramientas sigue aplicando; `allow: ["exec"]` permite implícitamente `apply_patch`.
- La configuración vive bajo `tools.exec.applyPatch`.
