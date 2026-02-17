---
title: Verificación Formal (Modelos de Seguridad)
summary: Modelos de seguridad verificados mecánicamente para las rutas de mayor riesgo de OpenClaw.
permalink: /es-ES/security/formal-verification/
---

# Verificación Formal (Modelos de Seguridad)

Esta página rastrea los **modelos de seguridad formales** de OpenClaw (TLA+/TLC hoy; más según sea necesario).

> Nota: algunos enlaces antiguos pueden referirse al nombre anterior del proyecto.

**Objetivo (estrella del norte):** proporcionar un argumento verificado mecánicamente de que OpenClaw hace cumplir su política de seguridad prevista (autorización, aislamiento de sesión, control de herramientas y seguridad ante configuraciones incorrectas), bajo suposiciones explícitas.

**Lo que es esto (hoy):** un **conjunto de regresión de seguridad** ejecutable y dirigido por atacantes:

- Cada afirmación tiene una verificación de modelo ejecutable sobre un espacio de estados finito.
- Muchas afirmaciones tienen un **modelo negativo** emparejado que produce una traza de contraejemplo para una clase de error realista.

**Lo que esto no es (todavía):** una prueba de que "OpenClaw es seguro en todos los aspectos" o de que la implementación completa de TypeScript es correcta.

## Dónde viven los modelos

Los modelos se mantienen en un repositorio separado: [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models).

## Advertencias importantes

- Estos son **modelos**, no la implementación completa de TypeScript. Es posible que haya desviación entre el modelo y el código.
- Los resultados están acotados por el espacio de estados explorado por TLC; "verde" no implica seguridad más allá de las suposiciones y límites modelados.
- Algunas afirmaciones dependen de suposiciones ambientales explícitas (p. ej., despliegue correcto, entradas de configuración correctas).

## Reproducir resultados

Hoy, los resultados se reproducen clonando el repositorio de modelos localmente y ejecutando TLC (ver abajo). Una iteración futura podría ofrecer:

- Modelos ejecutados en CI con artefactos públicos (trazas de contraejemplo, registros de ejecución)
- un flujo de trabajo alojado de "ejecutar este modelo" para verificaciones pequeñas y acotadas

Comenzando:

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Se requiere Java 11+ (TLC se ejecuta en la JVM).
# El repositorio incluye un `tla2tools.jar` fijo (herramientas TLA+) y proporciona `bin/tlc` + objetivos Make.

make <target>
```

### Exposición del Gateway y configuración incorrecta de gateway abierto

**Afirmación:** enlazar más allá del bucle local sin autenticación puede hacer posible el compromiso remoto / aumenta la exposición; token/contraseña bloquea a atacantes no autenticados (según las suposiciones del modelo).

- Ejecuciones verdes:
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- Rojo (esperado):
  - `make gateway-exposure-v2-negative`

Ver también: `docs/gateway-exposure-matrix.md` en el repositorio de modelos.

### Pipeline de Nodes.run (capacidad de mayor riesgo)

**Afirmación:** `nodes.run` requiere (a) lista de permitidos de comandos de nodo más comandos declarados y (b) aprobación en vivo cuando está configurado; las aprobaciones están tokenizadas para evitar repeticiones (en el modelo).

- Ejecuciones verdes:
  - `make nodes-pipeline`
  - `make approvals-token`
- Rojo (esperado):
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### Almacenamiento de emparejamiento (control de mensajes directos)

**Afirmación:** las solicitudes de emparejamiento respetan el TTL y los límites de solicitudes pendientes.

- Ejecuciones verdes:
  - `make pairing`
  - `make pairing-cap`
- Rojo (esperado):
  - `make pairing-negative`
  - `make pairing-cap-negative`

### Control de entrada (menciones + bypass de comando de control)

**Afirmación:** en contextos de grupo que requieren mención, un "comando de control" no autorizado no puede omitir el control de menciones.

- Verde:
  - `make ingress-gating`
- Rojo (esperado):
  - `make ingress-gating-negative`

### Enrutamiento/aislamiento de clave de sesión

**Afirmación:** los mensajes directos de pares distintos no se colapsan en la misma sesión a menos que estén explícitamente vinculados/configurados.

- Verde:
  - `make routing-isolation`
- Rojo (esperado):
  - `make routing-isolation-negative`

## v1++: modelos acotados adicionales (concurrencia, reintentos, corrección de trazas)

Estos son modelos de seguimiento que ajustan la fidelidad en torno a modos de falla del mundo real (actualizaciones no atómicas, reintentos y fan-out de mensajes).

### Concurrencia / idempotencia del almacenamiento de emparejamiento

**Afirmación:** un almacenamiento de emparejamiento debe hacer cumplir `MaxPending` e idempotencia incluso bajo entrelazamientos (es decir, "verificar-luego-escribir" debe ser atómico / bloqueado; la actualización no debe crear duplicados).

Lo que significa:

- Bajo solicitudes concurrentes, no se puede exceder `MaxPending` para un canal.
- Las solicitudes/actualizaciones repetidas para el mismo `(channel, sender)` no deben crear filas pendientes en vivo duplicadas.

- Ejecuciones verdes:
  - `make pairing-race` (verificación de límite atómico/bloqueado)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- Rojo (esperado):
  - `make pairing-race-negative` (carrera de límite de inicio/confirmación no atómico)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### Correlación de traza de ingreso / idempotencia

**Afirmación:** la ingesta debe preservar la correlación de traza a través del fan-out y ser idempotente bajo reintentos del proveedor.

Lo que significa:

- Cuando un evento externo se convierte en múltiples mensajes internos, cada parte mantiene la misma identidad de traza/evento.
- Los reintentos no resultan en procesamiento doble.
- Si faltan los ID de evento del proveedor, la deduplicación recurre a una clave segura (p. ej., ID de traza) para evitar eliminar eventos distintos.

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

**Afirmación:** el enrutamiento debe mantener las sesiones de mensajes directos aisladas de forma predeterminada, y solo colapsar sesiones cuando se configure explícitamente (precedencia de canal + enlaces de identidad).

Lo que significa:

- Las anulaciones de dmScope específicas del canal deben ganar sobre los valores predeterminados globales.
- identityLinks debe colapsar solo dentro de grupos vinculados explícitamente, no a través de pares no relacionados.

- Verde:
  - `make routing-precedence`
  - `make routing-identitylinks`
- Rojo (esperado):
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
