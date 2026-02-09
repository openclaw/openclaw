---
summary: "Protección de singleton del Gateway mediante el enlace del listener WebSocket"
read_when:
  - Al ejecutar o depurar el proceso del gateway
  - Al investigar la aplicación de instancia única
title: "Bloqueo del Gateway"
---

# Bloqueo del Gateway

Última actualización: 2025-12-11

## Por qué

- Garantizar que solo se ejecute una instancia del gateway por puerto base en el mismo host; los gateways adicionales deben usar perfiles aislados y puertos únicos.
- Sobrevivir a fallos/SIGKILL sin dejar archivos de bloqueo obsoletos.
- Fallar rápidamente con un error claro cuando el puerto de control ya está ocupado.

## Mecanismo

- El gateway enlaza el listener WebSocket (predeterminado `ws://127.0.0.1:18789`) inmediatamente al iniciar usando un listener TCP exclusivo.
- Si el enlace falla con `EADDRINUSE`, el inicio lanza `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- El sistema operativo libera el listener automáticamente al salir cualquier proceso, incluidos fallos y SIGKILL; no se necesita un archivo de bloqueo separado ni un paso de limpieza.
- Al apagarse, el gateway cierra el servidor WebSocket y el servidor HTTP subyacente para liberar el puerto con rapidez.

## Superficie de errores

- Si otro proceso mantiene el puerto, el inicio lanza `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- Otros fallos de enlace aparecen como `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`.

## Notas operativas

- Si el puerto está ocupado por _otro_ proceso, el error es el mismo; libere el puerto o elija otro con `openclaw gateway --port <port>`.
- La aplicación de macOS aún mantiene su propia protección ligera de PID antes de iniciar el gateway; el bloqueo en tiempo de ejecución se aplica mediante el enlace WebSocket.
