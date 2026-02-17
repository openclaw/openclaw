---
summary: "Manual para el servicio Gateway, ciclo de vida y operaciones"
read_when:
  - Ejecutando o depurando el proceso gateway
title: "Manual del Gateway"
---

# Manual del Gateway

Usa esta página para el arranque día-1 y operaciones día-2 del servicio Gateway.

<CardGroup cols={2}>
  <Card title="Solución de problemas profunda" icon="siren" href="/gateway/troubleshooting">
    Diagnósticos basados en síntomas con escaleras de comandos exactas y firmas de registro.
  </Card>
  <Card title="Configuración" icon="sliders" href="/gateway/configuration">
    Guía de configuración orientada a tareas + referencia completa de configuración.
  </Card>
</CardGroup>

## Inicio local en 5 minutos

<Steps>
  <Step title="Iniciar el Gateway">

```bash
openclaw gateway --port 18789
# debug/trace espejado a stdio
openclaw gateway --port 18789 --verbose
# forzar eliminación del listener en el puerto seleccionado, luego iniciar
openclaw gateway --force
```

  </Step>

  <Step title="Verificar salud del servicio">

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
```

Línea base saludable: `Runtime: running` y `RPC probe: ok`.

  </Step>

  <Step title="Validar preparación del canal">

```bash
openclaw channels status --probe
```

  </Step>
</Steps>

<Note>
La recarga de configuración del Gateway vigila la ruta del archivo de configuración activa (resuelta desde valores predeterminados de perfil/estado, o `OPENCLAW_CONFIG_PATH` cuando está establecida).
El modo predeterminado es `gateway.reload.mode="hybrid"`.
</Note>

## Modelo de runtime

- Un proceso siempre activo para enrutamiento, plano de control y conexiones de canal.
- Puerto único multiplexado para:
  - WebSocket control/RPC
  - APIs HTTP (compatible con OpenAI, Respuestas, invocación de herramientas)
  - Interfaz de Control y hooks
- Modo de enlace predeterminado: `loopback`.
- Autenticación requerida por defecto (`gateway.auth.token` / `gateway.auth.password`, o `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`).

### Precedencia de puerto y enlace

| Configuración  | Orden de resolución                                           |
| -------------- | ------------------------------------------------------------- |
| Puerto Gateway | `--port` → `OPENCLAW_GATEWAY_PORT` → `gateway.port` → `18789` |
| Modo de enlace | CLI/override → `gateway.bind` → `loopback`                    |

### Modos de recarga en caliente

| `gateway.reload.mode`     | Comportamiento                                                        |
| ------------------------- | --------------------------------------------------------------------- |
| `off`                     | Sin recarga de configuración                                          |
| `hot`                     | Aplicar solo cambios seguros en caliente                              |
| `restart`                 | Reiniciar en cambios que requieren recarga                            |
| `hybrid` (predeterminado) | Aplicar en caliente cuando sea seguro, reiniciar cuando sea necesario |

## Conjunto de comandos del operador

```bash
openclaw gateway status
openclaw gateway status --deep
openclaw gateway status --json
openclaw gateway install
openclaw gateway restart
openclaw gateway stop
openclaw logs --follow
openclaw doctor
```

## Acceso remoto

Preferido: Tailscale/VPN.
Alternativa: túnel SSH.

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

Luego conecta clientes a `ws://127.0.0.1:18789` localmente.

<Warning>
Si la autenticación del gateway está configurada, los clientes aún deben enviar autenticación (`token`/`password`) incluso sobre túneles SSH.
</Warning>

Consulta: [Gateway Remoto](/gateway/remote), [Autenticación](/gateway/authentication), [Tailscale](/gateway/tailscale).

## Supervisión y ciclo de vida del servicio

Usa ejecuciones supervisadas para confiabilidad tipo producción.

<Tabs>
  <Tab title="macOS (launchd)">

```bash
openclaw gateway install
openclaw gateway status
openclaw gateway restart
openclaw gateway stop
```

Las etiquetas LaunchAgent son `ai.openclaw.gateway` (predeterminado) o `ai.openclaw.<profile>` (perfil nombrado). `openclaw doctor` audita y repara la deriva de configuración del servicio.

  </Tab>

  <Tab title="Linux (systemd user)">

```bash
openclaw gateway install
systemctl --user enable --now openclaw-gateway[-<profile>].service
openclaw gateway status
```

Para persistencia después del cierre de sesión, habilita lingering:

```bash
sudo loginctl enable-linger <user>
```

  </Tab>

  <Tab title="Linux (servicio del sistema)">

Usa una unidad del sistema para hosts multi-usuario/siempre activos.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

  </Tab>
</Tabs>

## Múltiples gateways en un host

La mayoría de las configuraciones deberían ejecutar **un** Gateway.
Usa múltiples solo para aislamiento/redundancia estrictos (por ejemplo, un perfil de rescate).

Lista de verificación por instancia:

- `gateway.port` único
- `OPENCLAW_CONFIG_PATH` único
- `OPENCLAW_STATE_DIR` único
- `agents.defaults.workspace` único

Ejemplo:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

Consulta: [Múltiples gateways](/gateway/multiple-gateways).

### Ruta rápida del perfil dev

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
openclaw --dev status
```

Los valores predeterminados incluyen estado/configuración aislados y puerto base del gateway `19001`.

## Referencia rápida del protocolo (vista del operador)

- La primera trama del cliente debe ser `connect`.
- El Gateway devuelve instantánea `hello-ok` (`presence`, `health`, `stateVersion`, `uptimeMs`, límites/política).
- Solicitudes: `req(method, params)` → `res(ok/payload|error)`.
- Eventos comunes: `connect.challenge`, `agent`, `chat`, `presence`, `tick`, `health`, `heartbeat`, `shutdown`.

Las ejecuciones del agente son de dos etapas:

1. Acuse de recibo aceptado inmediato (`status:"accepted"`)
2. Respuesta de finalización final (`status:"ok"|"error"`), con eventos `agent` transmitidos en el medio.

Consulta la documentación completa del protocolo: [Protocolo del Gateway](/gateway/protocol).

## Verificaciones operacionales

### Vitalidad

- Abre WS y envía `connect`.
- Espera respuesta `hello-ok` con instantánea.

### Preparación

```bash
openclaw gateway status
openclaw channels status --probe
openclaw health
```

### Recuperación de brechas

Los eventos no se reproducen. En brechas de secuencia, refresca el estado (`health`, `system-presence`) antes de continuar.

## Firmas de falla comunes

| Firma                                                          | Problema probable                                  |
| -------------------------------------------------------------- | -------------------------------------------------- |
| `refusing to bind gateway ... without auth`                    | Enlace no-loopback sin token/password              |
| `another gateway instance is already listening` / `EADDRINUSE` | Conflicto de puerto                                |
| `Gateway start blocked: set gateway.mode=local`                | Configuración establecida en modo remoto           |
| `unauthorized` durante connect                                 | Desajuste de autenticación entre cliente y gateway |

Para escaleras de diagnóstico completas, usa [Solución de Problemas del Gateway](/gateway/troubleshooting).

## Garantías de seguridad

- Los clientes del protocolo Gateway fallan rápidamente cuando el Gateway no está disponible (sin alternativa implícita de canal directo).
- Las primeras tramas inválidas/no-connect se rechazan y cierran.
- El apagado gracioso emite evento `shutdown` antes del cierre del socket.

---

Relacionado:

- [Solución de Problemas](/gateway/troubleshooting)
- [Proceso en Segundo Plano](/gateway/background-process)
- [Configuración](/gateway/configuration)
- [Salud](/gateway/health)
- [Doctor](/gateway/doctor)
- [Autenticación](/gateway/authentication)
