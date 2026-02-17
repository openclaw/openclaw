---
title: Configuración de Desarrollo para macOS
description: Configurar tu entorno de desarrollo para la app de macOS de OpenClaw
---

# Configuración de Desarrollo para macOS

Esta guía te ayuda a configurar tu entorno de desarrollo local para trabajar en la app de macOS de OpenClaw.

## Prerrequisitos

- macOS 14.0 (Sonoma) o posterior
- Xcode 15.0 o posterior
- Node.js 22+ (para el CLI de OpenClaw)
- pnpm (gestor de paquetes)

## Configuración Inicial

### 1. Clonar el Repositorio

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

### 2. Instalar Dependencias

```bash
# Instalar dependencias del proyecto
pnpm install

# Construir el CLI de OpenClaw
pnpm build
```

### 3. Abrir el Proyecto de Xcode

```bash
open apps/macos/OpenClaw.xcodeproj
```

## Estructura del Proyecto

```
apps/macos/
├── Sources/
│   ├── OpenClaw/           # Código fuente principal de la app
│   │   ├── AppDelegate.swift
│   │   ├── GatewayManager.swift
│   │   ├── MenuBarController.swift
│   │   └── Resources/
│   └── OpenClawLauncher/   # Helper de lanzamiento
├── Tests/                   # Tests unitarios
└── OpenClaw.xcodeproj
```

## Configuración de Desarrollo

### Esquema de Construcción

1. En Xcode, selecciona el esquema **OpenClaw**
2. Elige tu Mac como destino de construcción
3. Configuración de construcción: **Debug**

### Firma de Código

Para desarrollo local:

1. Abre las configuraciones del proyecto
2. Ve a **Signing & Capabilities**
3. Marca **Automatically manage signing**
4. Selecciona tu equipo de desarrollo

### Variables de Entorno

Crea un archivo `.env` en `apps/macos/`:

```bash
# Configuración opcional del gateway
GATEWAY_PORT=18789
GATEWAY_LOG_LEVEL=debug

# Rutas de desarrollo
OPENCLAW_CONFIG_DIR=~/.openclaw-dev
```

## Flujo de Trabajo de Desarrollo

### Ejecución de la App

1. **Desde Xcode**: Presiona `Cmd + R` para construir y ejecutar
2. **Desde terminal**:
   ```bash
   pnpm dev:mac
   ```

### Recarga en Caliente

La app soporta recarga en caliente para ciertos componentes:

- Las habilidades pueden recargarse sin reiniciar
- Los cambios de configuración se aplican dinámicamente
- Las actualizaciones del gateway requieren reinicio

### Depuración

#### Depurador de Xcode

- Establece puntos de interrupción en el código Swift
- Usa `po` en la consola de depuración para inspeccionar variables
- El depurador de vista está disponible para la UI de SwiftUI

#### Logging

```swift
// Usa el sistema de logging unificado
import os.log

let logger = Logger(subsystem: "ai.openclaw.mac", category: "gateway")
logger.debug("Mensaje de depuración")
logger.info("Mensaje informativo")
logger.error("Mensaje de error")
```

Ver logs:

```bash
log stream --predicate 'subsystem == "ai.openclaw.mac"' --level debug
```

## Testing

### Ejecutar Tests

```bash
# Desde Xcode
Cmd + U

# Desde terminal
xcodebuild test -scheme OpenClaw -destination 'platform=macOS'
```

### Escribir Tests

```swift
import XCTest
@testable import OpenClaw

final class GatewayManagerTests: XCTestCase {
    func testGatewayStartup() async throws {
        let manager = GatewayManager()
        try await manager.start()
        XCTAssertTrue(manager.isRunning)
    }
}
```

## Problemas Comunes

### El Gateway No Se Inicia

- Verifica que el CLI de OpenClaw esté construido: `pnpm build`
- Revisa los permisos del puerto del gateway
- Mira los logs del gateway: `~/.openclaw/logs/gateway.log`

### Errores de Firma de Código

- Asegúrate de que el aprovisionamiento automático esté habilitado
- Verifica tu equipo de desarrollo en las configuraciones del proyecto
- Limpia la carpeta de construcción: `Cmd + Shift + K`

### Problemas de Rendimiento

- Usa la configuración de construcción Debug solo para desarrollo
- Perfila con Instruments para análisis de rendimiento
- Revisa los logs de uso de memoria y CPU

## Recursos

- [Documentación de SwiftUI](https://developer.apple.com/documentation/swiftui)
- [Guía de Logging de Apple](https://developer.apple.com/documentation/os/logging)
- [Documentación del CLI de OpenClaw](/es-ES/cli)
