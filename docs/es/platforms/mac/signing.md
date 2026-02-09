---
summary: "Pasos de firma para compilaciones de depuración de macOS generadas por scripts de empaquetado"
read_when:
  - Compilando o firmando compilaciones de depuración de mac
title: "Firma en macOS"
---

# firma en mac (compilaciones de depuración)

Esta app normalmente se compila desde [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), que ahora:

- establece un identificador de paquete de depuración estable: `ai.openclaw.mac.debug`
- escribe el Info.plist con ese id de paquete (anule mediante `BUNDLE_ID=...`)
- llama a [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) para firmar el binario principal y el paquete de la app, de modo que macOS trate cada recompilación como el mismo paquete firmado y conserve los permisos de TCC (notificaciones, accesibilidad, grabación de pantalla, micrófono, voz). Para permisos estables, use una identidad de firma real; la firma ad‑hoc es opcional y frágil (ver [permisos de macOS](/platforms/mac/permissions)).
- usa `CODESIGN_TIMESTAMP=auto` de forma predeterminada; habilita marcas de tiempo confiables para firmas Developer ID. Establezca `CODESIGN_TIMESTAMP=off` para omitir el sellado de tiempo (compilaciones de depuración sin conexión).
- inyecta metadatos de compilación en Info.plist: `OpenClawBuildTimestamp` (UTC) y `OpenClawGitCommit` (hash corto) para que el panel Acerca de muestre la compilación, git y el canal de depuración/lanzamiento.
- **El empaquetado requiere Node 22+**: el script ejecuta compilaciones de TS y la compilación de la UI de Control.
- lee `SIGN_IDENTITY` del entorno. Agregue `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (o su certificado Developer ID Application) a su rc de shell para firmar siempre con su certificado. La firma ad‑hoc requiere una habilitación explícita mediante `ALLOW_ADHOC_SIGNING=1` o `SIGN_IDENTITY="-"` (no recomendado para pruebas de permisos).
- ejecuta una auditoría de Team ID después de firmar y falla si algún Mach‑O dentro del paquete de la app está firmado por un Team ID diferente. Establezca `SKIP_TEAM_ID_CHECK=1` para omitirla.

## Uso

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### Nota sobre firma ad‑hoc

Al firmar con `SIGN_IDENTITY="-"` (ad‑hoc), el script deshabilita automáticamente el **Hardened Runtime** (`--options runtime`). Esto es necesario para evitar fallos cuando la app intenta cargar frameworks integrados (como Sparkle) que no comparten el mismo Team ID. Las firmas ad‑hoc también rompen la persistencia de permisos de TCC; consulte [permisos de macOS](/platforms/mac/permissions) para los pasos de recuperación.

## Metadatos de compilación para Acerca de

`package-mac-app.sh` estampa el paquete con:

- `OpenClawBuildTimestamp`: ISO8601 UTC en el momento del empaquetado
- `OpenClawGitCommit`: hash corto de git (o `unknown` si no está disponible)

La pestaña Acerca de lee estas claves para mostrar la versión, la fecha de compilación, el commit de git y si es una compilación de depuración (mediante `#if DEBUG`). Ejecute el empaquetador para actualizar estos valores después de cambios en el código.

## Por qué

Los permisos de TCC están vinculados al identificador del paquete _y_ a la firma de código. Las compilaciones de depuración sin firmar con UUID cambiantes estaban haciendo que macOS olvidara las concesiones después de cada recompilación. Firmar los binarios (ad‑hoc de forma predeterminada) y mantener un id/ruta de paquete fijo (`dist/OpenClaw.app`) conserva las concesiones entre compilaciones, igualando el enfoque de VibeTunnel.
