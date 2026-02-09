---
summary: "Comando de ubicación para nodos (location.get), modos de permisos y comportamiento en segundo plano"
read_when:
  - Agregar soporte de nodo de ubicación o UI de permisos
  - Diseñar flujos de ubicación en segundo plano + push
title: "Comando de ubicación"
---

# Comando de ubicación (nodos)

## TL;DR

- `location.get` es un comando de nodo (vía `node.invoke`).
- Desactivado por defecto.
- La configuración usa un selector: Desactivado / Mientras se usa / Siempre.
- Alternador separado: Ubicación precisa.

## Por qué un selector (no solo un interruptor)

Los permisos del SO son multinivel. Podemos exponer un selector en la app, pero el SO sigue decidiendo la concesión real.

- iOS/macOS: el usuario puede elegir **Mientras se usa** o **Siempre** en los avisos/Configuración del sistema. La app puede solicitar una actualización, pero el SO puede requerir Configuración.
- Android: la ubicación en segundo plano es un permiso separado; en Android 10+ a menudo requiere un flujo de Configuración.
- La ubicación precisa es una concesión separada (iOS 14+ “Precisa”, Android “fina” vs “aproximada”).

El selector en la UI dirige nuestro modo solicitado; la concesión real vive en la configuración del SO.

## Modelo de configuración

Por dispositivo de nodo:

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

Comportamiento de la UI:

- Seleccionar `whileUsing` solicita permiso en primer plano.
- Seleccionar `always` primero garantiza `whileUsing`, luego solicita segundo plano (o envía al usuario a Configuración si es necesario).
- Si el SO niega el nivel solicitado, volver al nivel más alto concedido y mostrar el estado.

## Mapeo de permisos (node.permissions)

Opcional. El nodo de macOS reporta `location` mediante el mapa de permisos; iOS/Android pueden omitirlo.

## Comando: `location.get`

Se llama vía `node.invoke`.

Parámetros (sugeridos):

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

Carga de respuesta:

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "altitudeMeters": 182.0,
  "speedMps": 0.0,
  "headingDeg": 270.0,
  "timestamp": "2026-01-03T12:34:56.000Z",
  "isPrecise": true,
  "source": "gps|wifi|cell|unknown"
}
```

Errores (códigos estables):

- `LOCATION_DISABLED`: el selector está desactivado.
- `LOCATION_PERMISSION_REQUIRED`: falta permiso para el modo solicitado.
- `LOCATION_BACKGROUND_UNAVAILABLE`: la app está en segundo plano pero solo se permite Mientras se usa.
- `LOCATION_TIMEOUT`: no hubo fijación a tiempo.
- `LOCATION_UNAVAILABLE`: falla del sistema / sin proveedores.

## Comportamiento en segundo plano (futuro)

Objetivo: el modelo puede solicitar ubicación incluso cuando el nodo está en segundo plano, pero solo cuando:

- El usuario seleccionó **Siempre**.
- El sistema operativo proporciona una ubicación en segundo plano.
- La app puede ejecutarse en segundo plano para ubicación (modo de fondo de iOS / servicio en primer plano de Android o permiso especial).

Flujo activado por push (futuro):

1. El Gateway envía un push al nodo (push silencioso o datos FCM).
2. El nodo se despierta brevemente y solicita la ubicación al dispositivo.
3. El nodo reenvía la carga al Gateway.

Notas:

- iOS: se requiere permiso Siempre + modo de ubicación en segundo plano. El push silencioso puede ser limitado; espere fallas intermitentes.
- Android: la ubicación en segundo plano puede requerir un servicio en primer plano; de lo contrario, espere denegación.

## Integración con modelo/herramientas

- Superficie de herramientas: la herramienta `nodes` agrega la acción `location_get` (nodo requerido).
- CLI: `openclaw nodes location get --node <id>`.
- Guías del Agente: llamar solo cuando el usuario habilitó la ubicación y comprende el alcance.

## Copia de UX (sugerida)

- Desactivado: “El uso compartido de ubicación está deshabilitado.”
- Mientras se usa: “Solo cuando OpenClaw está abierto.”
- Siempre: “Permitir ubicación en segundo plano. Requiere permiso del sistema.”
- Precisa: “Usar ubicación GPS precisa. Desactive para compartir ubicación aproximada.”
