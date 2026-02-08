---
title: Verificación formal (Modelos de seguridad)
summary: Modelos de seguridad verificados por máquina para las rutas de mayor riesgo de OpenClaw.
permalink: /security/formal-verification/
x-i18n:
  source_path: security/formal-verification.md
  source_hash: 8dff6ea41a37fb6b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:34:43Z
---

# Verificación formal (Modelos de seguridad)

Esta página da seguimiento a los **modelos formales de seguridad** de OpenClaw (TLA+/TLC hoy; más según sea necesario).

> Nota: algunos enlaces antiguos pueden referirse al nombre previo del proyecto.

**Objetivo (estrella norte):** proporcionar un argumento verificado por máquina de que OpenClaw aplica su
política de seguridad prevista (autorización, aislamiento de sesiones, control de herramientas y
seguridad ante malas configuraciones), bajo supuestos explícitos.

**Qué es esto (hoy):** una **suite de regresión de seguridad** ejecutable y orientada al atacante:

- Cada afirmación tiene una verificación por model checking ejecutable sobre un espacio de estados finito.
- Muchas afirmaciones tienen un **modelo negativo** emparejado que produce una traza de contraejemplo para una clase realista de fallos.

**Qué no es (todavía):** una prueba de que “OpenClaw es seguro en todos los aspectos” ni de que la implementación completa en TypeScript sea correcta.

## Dónde viven los modelos

Los modelos se mantienen en un repositorio separado: [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models).

## Advertencias importantes

- Estos son **modelos**, no la implementación completa en TypeScript. Puede existir deriva entre el modelo y el código.
- Los resultados están acotados por el espacio de estados explorado por TLC; que esté “en verde” no implica seguridad más allá de los supuestos y límites modelados.
- Algunas afirmaciones dependen de supuestos ambientales explícitos (p. ej., despliegue correcto, entradas de configuración correctas).

## Reproducción de resultados

Hoy, los resultados se reproducen clonando el repositorio de modelos localmente y ejecutando TLC (ver abajo). Una iteración futura podría ofrecer:

- Modelos ejecutados en CI con artefactos públicos (trazas de contraejemplos, registros de ejecución)
- Un flujo de trabajo alojado de “ejecutar este modelo” para verificaciones pequeñas y acotadas

Primeros pasos:

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.

make <target>
```

### Exposición del Gateway y mala configuración de gateway abierto

**Afirmación:** enlazar más allá de loopback sin autenticación puede hacer posible el compromiso remoto / aumenta la exposición; el token/contraseña bloquea a atacantes no autorizados (según los supuestos del modelo).

- Ejecuciones en verde:
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- Rojo (esperado):
  - `make gateway-exposure-v2-negative`

Véase también: `docs/gateway-exposure-matrix.md` en el repositorio de modelos.

### Canalización Nodes.run (capacidad de mayor riesgo)

**Afirmación:** `nodes.run` requiere (a) una lista de permitidos de comandos de nodo más comandos declarados y (b) aprobación en vivo cuando está configurado; las aprobaciones están tokenizadas para evitar repetición (en el modelo).

- Ejecuciones en verde:
  - `make nodes-pipeline`
  - `make approvals-token`
- Rojo (esperado):
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### Almacén de emparejamiento (control de mensajes directos)

**Afirmación:** las solicitudes de emparejamiento respetan TTL y los límites de solicitudes pendientes.

- Ejecuciones en verde:
  - `make pairing`
  - `make pairing-cap`
- Rojo (esperado):
  - `make pairing-negative`
  - `make pairing-cap-negative`

### Control de ingreso (menciones + bypass de comandos de control)

**Afirmación:** en contextos de grupo que requieren mención, un “comando de control” no autorizado no puede eludir el control por mención.

- Verde:
  - `make ingress-gating`
- Rojo (esperado):
  - `make ingress-gating-negative`

### Aislamiento de enrutamiento/clave de sesión

**Afirmación:** los mensajes directos de pares distintos no colapsan en la misma sesión a menos que se vinculen/configuren explícitamente.

- Verde:
  - `make routing-isolation`
- Rojo (esperado):
  - `make routing-isolation-negative`

## v1++: modelos acotados adicionales (concurrencia, reintentos, corrección de trazas)

Estos son modelos de seguimiento que aumentan la fidelidad frente a modos de fallo del mundo real (actualizaciones no atómicas, reintentos y distribución de mensajes).

### Concurrencia / idempotencia del almacén de emparejamiento

**Afirmación:** un almacén de emparejamiento debe imponer `MaxPending` e idempotencia incluso bajo entrelazados (es decir, “verificar y luego escribir” debe ser atómico/bloqueado; la actualización no debe crear duplicados).

Qué significa:

- Bajo solicitudes concurrentes, no se puede exceder `MaxPending` para un canal.
- Las solicitudes/actualizaciones repetidas para el mismo `(channel, sender)` no deben crear filas pendientes vivas duplicadas.

- Ejecuciones en verde:
  - `make pairing-race` (verificación de límite atómica/bloqueada)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- Rojo (esperado):
  - `make pairing-race-negative` (condición de carrera de límite por begin/commit no atómico)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### Correlación de trazas de ingreso / idempotencia

**Afirmación:** la ingestión debe preservar la correlación de trazas a través de la distribución y ser idempotente ante reintentos del proveedor.

Qué significa:

- Cuando un evento externo se convierte en múltiples mensajes internos, cada parte mantiene la misma identidad de traza/evento.
- Los reintentos no dan lugar a procesamiento doble.
- Si faltan los ID de eventos del proveedor, la desduplicación recurre a una clave segura (p. ej., ID de traza) para evitar descartar eventos distintos.

- Verde:
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- Rojo (esperado):
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### Precedencia de dmScope de enrutamiento + identityLinks

**Afirmación:** el enrutamiento debe mantener las sesiones de mensajes directos aisladas por defecto y solo colapsar sesiones cuando se configura explícitamente (precedencia de canal + enlaces de identidad).

Qué significa:

- Las anulaciones de dmScope específicas del canal deben prevalecer sobre los valores predeterminados globales.
- identityLinks solo deben colapsar dentro de grupos vinculados explícitamente, no entre pares no relacionados.

- Verde:
  - `make routing-precedence`
  - `make routing-identitylinks`
- Rojo (esperado):
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
