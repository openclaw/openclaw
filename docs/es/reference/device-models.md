---
summary: "Cómo OpenClaw provee identificadores de modelos de dispositivos Apple con nombres amigables en la app de macOS."
read_when:
  - Actualizar las asignaciones de identificadores de modelos de dispositivos o los archivos NOTICE/licencia
  - Cambiar cómo la UI de Instancias muestra los nombres de dispositivos
title: "Base de datos de modelos de dispositivos"
---

# Base de datos de modelos de dispositivos (nombres amigables)

La aplicación complementaria de macOS muestra nombres amigables de modelos de dispositivos Apple en la UI de **Instancias** mediante la asignación de identificadores de modelos de Apple (p. ej., `iPad16,6`, `Mac16,6`) a nombres legibles para humanos.

La asignación se provee como JSON en:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## Fuente de datos

Actualmente proveemos la asignación desde el repositorio con licencia MIT:

- `kyle-seongwoo-jun/apple-device-identifiers`

Para mantener compilaciones deterministas, los archivos JSON están fijados a commits específicos del upstream (registrados en `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`).

## Actualización de la base de datos

1. Elija los commits del upstream que desea fijar (uno para iOS y uno para macOS).
2. Actualice los hashes de commit en `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`.
3. Vuelva a descargar los archivos JSON, fijados a esos commits:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. Asegúrese de que `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` aún coincida con el upstream (reemplácelo si la licencia del upstream cambia).
5. Verifique que la app de macOS compile correctamente (sin advertencias):

```bash
swift build --package-path apps/macos
```
