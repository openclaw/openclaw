---
summary: "Comando de ubicación para nodos (location.get), modos de permiso y comportamiento en segundo plano"
read_when:
  - Agregar soporte de nodo de ubicación o interfaz de permisos
  - Diseñar flujos de ubicación en segundo plano + push
title: "Comando de Ubicación"
---

# Comando de ubicación (nodos)

## Resumen

- `location.get` es un comando de nodo (mediante `node.invoke`).
- Desactivado de forma predeterminada.
- La configuración usa un selector: Desactivado / Mientras se usa / Siempre.
- Interruptor separado: Ubicación precisa.

## Por qué un selector (no solo un interruptor)

Los permisos del sistema operativo son multinivel. Podemos exponer un selector en la aplicación, pero el sistema operativo aún decide la concesión real.

- iOS/macOS: el usuario puede elegir **Mientras se usa** o **Siempre** en avisos del sistema/Configuración. La aplicación puede solicitar actualización, pero el sistema operativo puede requerir Configuración.
- Android: la ubicación en segundo plano es un permiso separado; en Android 10+ a menudo requiere un flujo de Configuración.
- La ubicación precisa es una concesión separada (iOS 14+ "Precisa", Android "fine" vs "coarse").

El selector en la interfaz impulsa nuestro modo solicitado; la concesión real vive en la configuración del sistema operativo.

## Modelo de configuración

Por dispositivo de nodo:

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

Comportamiento de la interfaz:

- Seleccionar `whileUsing` solicita permiso en primer plano.
- Seleccionar `always` primero asegura `whileUsing`, luego solicita segundo plano (o envía al usuario a Configuración si es requerido).
- Si el sistema operativo niega el nivel solicitado, revertir al nivel concedido más alto y mostrar estado.

## Mapeo de permisos (node.permissions)

Opcional. El nodo macOS informa `location` mediante el mapa de permisos; iOS/Android pueden omitirlo.

## Comando: `location.get`

Llamado mediante `node.invoke`.

Parámetros (sugeridos):

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

Carga útil de respuesta:

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
- `LOCATION_BACKGROUND_UNAVAILABLE`: la aplicación está en segundo plano pero solo se permite Mientras se usa.
- `LOCATION_TIMEOUT`: sin ubicación a tiempo.
- `LOCATION_UNAVAILABLE`: falla del sistema / sin proveedores.

## Comportamiento en segundo plano (futuro)

Objetivo: el modelo puede solicitar ubicación incluso cuando el nodo está en segundo plano, pero solo cuando:

- El usuario seleccionó **Siempre**.
- El sistema operativo otorga ubicación en segundo plano.
- La aplicación puede ejecutarse en segundo plano para ubicación (modo en segundo plano de iOS / servicio en primer plano de Android o permiso especial).

Flujo activado por push (futuro):

1. El Gateway envía un push al nodo (push silencioso o datos FCM).
2. El nodo se despierta brevemente y solicita ubicación del dispositivo.
3. El nodo reenvía la carga útil al Gateway.

Notas:

- iOS: Se requiere permiso Siempre + modo de ubicación en segundo plano. El push silencioso puede estar limitado; espera fallos intermitentes.
- Android: la ubicación en segundo plano puede requerir un servicio en primer plano; de lo contrario, espera denegación.

## Integración de modelo/herramientas

- Superficie de herramienta: la herramienta `nodes` agrega acción `location_get` (nodo requerido).
- CLI: `openclaw nodes location get --node <id>`.
- Pautas del agente: solo llamar cuando el usuario habilite la ubicación y comprenda el alcance.

## Texto de UX (sugerido)

- Desactivado: "El compartir ubicación está deshabilitado."
- Mientras se usa: "Solo cuando OpenClaw está abierto."
- Siempre: "Permitir ubicación en segundo plano. Requiere permiso del sistema."
- Precisa: "Usar ubicación GPS precisa. Desactivar para compartir ubicación aproximada."
