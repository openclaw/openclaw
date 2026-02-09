---
summary: "Guía de configuración para desarrolladores que trabajan en la aplicación OpenClaw para macOS"
read_when:
  - Configuración del entorno de desarrollo de macOS
title: "Configuración de desarrollo en macOS"
---

# Configuración para desarrolladores de macOS

Esta guía cubre los pasos necesarios para compilar y ejecutar la aplicación OpenClaw para macOS desde el código fuente.

## Requisitos previos

Antes de compilar la aplicación, asegúrese de tener instalado lo siguiente:

1. **Xcode 26.2+**: Requerido para el desarrollo en Swift.
2. **Node.js 22+ y pnpm**: Requeridos para el Gateway, la CLI y los scripts de empaquetado.

## 1) Instalar dependencias

Instale las dependencias de todo el proyecto:

```bash
pnpm install
```

## 2. Compilar y empaquetar la app

Para compilar la app de macOS y empaquetarla en `dist/OpenClaw.app`, ejecute:

```bash
./scripts/package-mac-app.sh
```

Si no tiene un certificado de Apple Developer ID, el script usará automáticamente **firma ad-hoc** (`-`).

Para modos de ejecución de desarrollo, banderas de firma y solución de problemas del Team ID, consulte el README de la app de macOS:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **Nota**: Las apps firmadas ad-hoc pueden activar avisos de seguridad. Si la app se cierra inmediatamente con "Abort trap 6", consulte la sección de [Solución de problemas](#solución-de-problemas).

## 3. Instalar la CLI

La app de macOS espera una instalación global de la CLI `openclaw` para gestionar tareas en segundo plano.

**Para instalarla (recomendado):**

1. Abra la app OpenClaw.
2. Vaya a la pestaña de configuración **General**.
3. Haga clic en **"Install CLI"**.

Alternativamente, instálela manualmente:

```bash
npm install -g openclaw@<version>
```

## Solución de problemas

### La compilación falla: incompatibilidad de toolchain o SDK

La compilación de la app de macOS espera el SDK más reciente de macOS y el toolchain de Swift 6.2.

**Dependencias del sistema (requeridas):**

- **La versión más reciente de macOS disponible en Software Update** (requerida por los SDK de Xcode 26.2)
- **Xcode 26.2** (toolchain de Swift 6.2)

**Comprobaciones:**

```bash
xcodebuild -version
xcrun swift --version
```

Si las versiones no coinciden, actualice macOS/Xcode y vuelva a ejecutar la compilación.

### La app se cierra al conceder permisos

Si la app se cierra cuando intenta permitir el acceso a **Reconocimiento de voz** o **Micrófono**, puede deberse a una caché TCC corrupta o a una incompatibilidad de firma.

**Solución:**

1. Restablezca los permisos de TCC:

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. Si eso falla, cambie temporalmente el `BUNDLE_ID` en [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) para forzar un "estado limpio" en macOS.

### El Gateway queda en "Starting..." indefinidamente

Si el estado del Gateway permanece en "Starting...", verifique si un proceso zombie está ocupando el puerto:

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

Si una ejecución manual está ocupando el puerto, detenga ese proceso (Ctrl+C). Como último recurso, finalice el PID que encontró arriba.
