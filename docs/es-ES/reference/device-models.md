---
summary: "Cómo OpenClaw vende identificadores de modelo de dispositivos Apple para nombres amigables en la app de macOS."
read_when:
  - Actualizar mapeos de identificadores de modelo de dispositivo o archivos NOTICE/licencia
  - Cambiar cómo la UI de Instancias muestra nombres de dispositivos
title: "Base de Datos de Modelos de Dispositivos"
---

# Base de datos de modelos de dispositivos (nombres amigables)

La app complementaria de macOS muestra nombres amigables de modelos de dispositivos Apple en la UI de **Instancias** mapeando identificadores de modelo de Apple (ej. `iPad16,6`, `Mac16,6`) a nombres legibles para humanos.

El mapeo está vendido como JSON bajo:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## Fuente de datos

Actualmente vendemos el mapeo del repositorio con licencia MIT:

- `kyle-seongwoo-jun/apple-device-identifiers`

Para mantener las compilaciones determinísticas, los archivos JSON están fijados a commits específicos upstream (registrados en `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`).

## Actualizar la base de datos

1. Elige los commits upstream a los que deseas fijar (uno para iOS, uno para macOS).
2. Actualiza los hashes de commit en `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`.
3. Re-descarga los archivos JSON, fijados a esos commits:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. Asegúrate de que `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` aún coincida con upstream (reemplázalo si cambia la licencia upstream).
5. Verifica que la app de macOS compile limpiamente (sin advertencias):

```bash
swift build --package-path apps/macos
```
