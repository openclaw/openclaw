---
summary: "Pasos de firma para compilaciones de depuración de macOS generadas por scripts de empaquetado"
read_when:
  - Construyendo o firmando compilaciones de depuración de Mac
title: "Firma de macOS"
---

# Firma de Mac (compilaciones de depuración)

Esta app generalmente se construye desde [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), que ahora:

- establece un identificador de bundle de depuración estable: `ai.openclaw.mac.debug`
- escribe el Info.plist con ese bundle id (anula vía `BUNDLE_ID=...`)
- llama a [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) para firmar el binario principal y el bundle de la app para que macOS trate cada recompilación como el mismo bundle firmado y mantenga los permisos TCC (notificaciones, accesibilidad, grabación de pantalla, micrófono, habla). Para permisos estables, usa una identidad de firma real; ad-hoc es opt-in y frágil (ve [permisos de macOS](/es-ES/platforms/mac/permissions)).
- usa `CODESIGN_TIMESTAMP=auto` por defecto; habilita marcas de tiempo confiables para firmas de Developer ID. Establece `CODESIGN_TIMESTAMP=off` para omitir timestamping (compilaciones de depuración offline).
- inyecta metadatos de compilación en Info.plist: `OpenClawBuildTimestamp` (UTC) y `OpenClawGitCommit` (hash corto) para que el panel About pueda mostrar compilación, git y canal debug/release.
- **El empaquetado requiere Node 22+**: el script ejecuta compilaciones TS y la compilación de Control UI.
- lee `SIGN_IDENTITY` del entorno. Añade `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (o tu certificado Developer ID Application) a tu rc de shell para siempre firmar con tu certificado. La firma ad-hoc requiere opt-in explícito vía `ALLOW_ADHOC_SIGNING=1` o `SIGN_IDENTITY="-"` (no recomendado para pruebas de permisos).
- ejecuta una auditoría de Team ID después de firmar y falla si algún Mach-O dentro del bundle de la app está firmado por un Team ID diferente. Establece `SKIP_TEAM_ID_CHECK=1` para omitir.

## Uso

```bash
# desde la raíz del repo
scripts/package-mac-app.sh               # auto-selecciona identidad; error si no se encuentra ninguna
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # cert real
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (los permisos no persistirán)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # ad-hoc explícito (misma advertencia)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # solución alternativa de desajuste de Team ID de Sparkle solo para dev
```

### Nota de Firma Ad-hoc

Al firmar con `SIGN_IDENTITY="-"` (ad-hoc), el script deshabilita automáticamente el **Hardened Runtime** (`--options runtime`). Esto es necesario para prevenir caídas cuando la app intenta cargar frameworks incrustados (como Sparkle) que no comparten el mismo Team ID. Las firmas ad-hoc también rompen la persistencia de permisos TCC; ve [permisos de macOS](/es-ES/platforms/mac/permissions) para pasos de recuperación.

## Metadatos de compilación para About

`package-mac-app.sh` marca el bundle con:

- `OpenClawBuildTimestamp`: ISO8601 UTC en tiempo de empaquetado
- `OpenClawGitCommit`: hash corto de git (o `unknown` si no está disponible)

La pestaña About lee estas claves para mostrar versión, fecha de compilación, commit de git, y si es una compilación de depuración (vía `#if DEBUG`). Ejecuta el empaquetador para refrescar estos valores después de cambios de código.

## Por qué

Los permisos TCC están vinculados al identificador del bundle _y_ la firma de código. Las compilaciones de depuración sin firmar con UUIDs cambiantes estaban causando que macOS olvidara otorgamientos después de cada recompilación. Firmar los binarios (ad‑hoc por defecto) y mantener un bundle id/ruta fijo (`dist/OpenClaw.app`) preserva los otorgamientos entre compilaciones, coincidiendo con el enfoque de VibeTunnel.
