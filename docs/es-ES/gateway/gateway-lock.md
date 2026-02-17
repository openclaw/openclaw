---
summary: "Protección singleton del Gateway usando el enlace del listener WebSocket"
read_when:
  - Ejecutando o depurando el proceso del gateway
  - Investigando aplicación de instancia única
title: "Bloqueo del Gateway"
---

# Bloqueo del gateway

Última actualización: 2025-12-11

## Por qué

- Asegurar que solo una instancia del gateway se ejecute por puerto base en el mismo host; gateways adicionales deben usar perfiles aislados y puertos únicos.
- Sobrevivir crashes/SIGKILL sin dejar archivos de bloqueo obsoletos.
- Fallar rápido con un error claro cuando el puerto de control ya está ocupado.

## Mecanismo

- El gateway vincula el listener WebSocket (predeterminado `ws://127.0.0.1:18789`) inmediatamente al inicio usando un listener TCP exclusivo.
- Si el bind falla con `EADDRINUSE`, el inicio lanza `GatewayLockError("otra instancia del gateway ya está escuchando en ws://127.0.0.1:<puerto>")`.
- El SO libera el listener automáticamente en cualquier salida de proceso, incluyendo crashes y SIGKILL—no se necesita archivo de bloqueo separado o paso de limpieza.
- Al apagarse el gateway cierra el servidor WebSocket y el servidor HTTP subyacente para liberar el puerto rápidamente.

## Superficie de error

- Si otro proceso mantiene el puerto, el inicio lanza `GatewayLockError("otra instancia del gateway ya está escuchando en ws://127.0.0.1:<puerto>")`.
- Otras fallas de bind aparecen como `GatewayLockError("falló al vincular socket del gateway en ws://127.0.0.1:<puerto>: …")`.

## Notas operacionales

- Si el puerto está ocupado por _otro_ proceso, el error es el mismo; libera el puerto o elige otro con `openclaw gateway --port <puerto>`.
- La app macOS aún mantiene su propia protección ligera de PID antes de generar el gateway; el bloqueo de runtime se aplica por el bind WebSocket.
