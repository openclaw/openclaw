---
title: "Lista de Verificación de Lanzamiento"
summary: "Lista de verificación paso a paso para lanzamiento de npm + app de macOS"
read_when:
  - Publicar un nuevo lanzamiento de npm
  - Publicar un nuevo lanzamiento de la app de macOS
  - Verificar metadatos antes de publicar
---

# Lista de Verificación de Lanzamiento (npm + macOS)

Usa `pnpm` (Node 22+) desde la raíz del repositorio. Mantén el árbol de trabajo limpio antes de etiquetar/publicar.

## Activador del operador

Cuando el operador dice "release", haz inmediatamente este pre-vuelo (sin preguntas adicionales a menos que estés bloqueado):

- Lee este documento y `docs/platforms/mac/release.md`.
- Carga env desde `~/.profile` y confirma que `SPARKLE_PRIVATE_KEY_FILE` + vars de App Store Connect están configuradas (SPARKLE_PRIVATE_KEY_FILE debe vivir en `~/.profile`).
- Usa claves de Sparkle desde `~/Library/CloudStorage/Dropbox/Backup/Sparkle` si es necesario.

1. **Versión y metadatos**

- [ ] Incrementa la versión de `package.json` (ej., `2026.1.29`).
- [ ] Ejecuta `pnpm plugins:sync` para alinear versiones de paquetes de extensión + changelogs.
- [ ] Actualiza cadenas de CLI/versión: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) y el agente de usuario de Baileys en [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts).
- [ ] Confirma metadatos del paquete (nombre, descripción, repositorio, palabras clave, licencia) y que el mapa `bin` apunta a [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) para `openclaw`.
- [ ] Si cambiaron las dependencias, ejecuta `pnpm install` para que `pnpm-lock.yaml` esté actualizado.

2. **Compilación y artefactos**

- [ ] Si cambiaron las entradas de A2UI, ejecuta `pnpm canvas:a2ui:bundle` y confirma cualquier [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js) actualizado.
- [ ] `pnpm run build` (regenera `dist/`).
- [ ] Verifica que los `files` del paquete npm incluyan todas las carpetas `dist/*` requeridas (notablemente `dist/node-host/**` y `dist/acp/**` para node headless + CLI de ACP).
- [ ] Confirma que `dist/build-info.json` existe e incluye el hash de `commit` esperado (el banner del CLI usa esto para instalaciones npm).
- [ ] Opcional: `npm pack --pack-destination /tmp` después de la compilación; inspecciona el contenido del tarball y mantenlo a mano para el lanzamiento de GitHub (no lo confirmes en git).

3. **Changelog y documentación**

- [ ] Actualiza `CHANGELOG.md` con destacados para usuarios (crea el archivo si falta); mantén las entradas estrictamente descendentes por versión.
- [ ] Asegúrate de que los ejemplos/flags del README coincidan con el comportamiento actual del CLI (notablemente nuevos comandos u opciones).

4. **Validación**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (o `pnpm test:coverage` si necesitas salida de cobertura)
- [ ] `pnpm release:check` (verifica contenidos de npm pack)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (prueba de humo de instalación Docker, ruta rápida; requerido antes del lanzamiento)
  - Si se sabe que el lanzamiento npm inmediatamente anterior está roto, establece `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<última-versión-buena>` o `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` para el paso de preinstalación.
- [ ] (Opcional) Prueba de humo completa del instalador (agrega cobertura de no-root + CLI): `pnpm test:install:smoke`
- [ ] (Opcional) E2E del instalador (Docker, ejecuta `curl -fsSL https://openclaw.ai/install.sh | bash`, incorpora, luego ejecuta llamadas a herramientas reales):
  - `pnpm test:install:e2e:openai` (requiere `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (requiere `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (requiere ambas claves; ejecuta ambos proveedores)
- [ ] (Opcional) Verifica el gateway web si tus cambios afectan rutas de envío/recepción.

5. **App de macOS (Sparkle)**

- [ ] Compila + firma la app de macOS, luego comprímela para distribución.
- [ ] Genera el appcast de Sparkle (notas HTML vía [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)) y actualiza `appcast.xml`.
- [ ] Mantén el zip de la app (y zip dSYM opcional) listo para adjuntar al lanzamiento de GitHub.
- [ ] Sigue [lanzamiento de macOS](/es-ES/platforms/mac/release) para los comandos exactos y vars env requeridas.
  - `APP_BUILD` debe ser numérico + monótono (sin `-beta`) para que Sparkle compare versiones correctamente.
  - Si notarizas, usa el perfil de llavero `openclaw-notary` creado desde vars env de API de App Store Connect (ver [lanzamiento de macOS](/es-ES/platforms/mac/release)).

6. **Publicar (npm)**

- [ ] Confirma que el estado de git está limpio; confirma y empuja según sea necesario.
- [ ] `npm login` (verifica 2FA) si es necesario.
- [ ] `npm publish --access public` (usa `--tag beta` para prelanzamientos).
- [ ] Verifica el registro: `npm view openclaw version`, `npm view openclaw dist-tags`, y `npx -y openclaw@X.Y.Z --version` (o `--help`).

### Solución de problemas (notas del lanzamiento 2.0.0-beta2)

- **npm pack/publish cuelga o produce tarball enorme**: el bundle de la app de macOS en `dist/OpenClaw.app` (y zips de lanzamiento) se incluyen en el paquete. Arregla mediante lista blanca de contenidos de publicación vía `files` de `package.json` (incluye subdirs de dist, docs, skills; excluye bundles de app). Confirma con `npm pack --dry-run` que `dist/OpenClaw.app` no está listado.
- **bucle web de autenticación npm para dist-tags**: usa autenticación legacy para obtener un prompt de OTP:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **la verificación de `npx` falla con `ECOMPROMISED: Lock compromised`**: reintenta con un cache fresco:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **La etiqueta necesita reapuntar después de un arreglo tardío**: actualiza por fuerza y empuja la etiqueta, luego asegúrate de que los activos del lanzamiento de GitHub aún coincidan:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **Lanzamiento de GitHub + appcast**

- [ ] Etiqueta y empuja: `git tag vX.Y.Z && git push origin vX.Y.Z` (o `git push --tags`).
- [ ] Crea/refresca el lanzamiento de GitHub para `vX.Y.Z` con **título `openclaw X.Y.Z`** (no solo la etiqueta); el cuerpo debe incluir la sección **completa** del changelog para esa versión (Highlights + Changes + Fixes), inline (sin enlaces desnudos), y **no debe repetir el título dentro del cuerpo**.
- [ ] Adjunta artefactos: tarball de `npm pack` (opcional), `OpenClaw-X.Y.Z.zip`, y `OpenClaw-X.Y.Z.dSYM.zip` (si se generó).
- [ ] Confirma el `appcast.xml` actualizado y empújalo (Sparkle se alimenta desde main).
- [ ] Desde un directorio temporal limpio (sin `package.json`), ejecuta `npx -y openclaw@X.Y.Z send --help` para confirmar que los puntos de entrada de instalación/CLI funcionan.
- [ ] Anuncia/comparte notas de lanzamiento.

## Alcance de publicación de plugins (npm)

Solo publicamos **plugins npm existentes** bajo el alcance `@openclaw/*`. Los
plugins empaquetados que no están en npm permanecen **solo en árbol de disco** (aún enviados en
`extensions/**`).

Proceso para derivar la lista:

1. `npm search @openclaw --json` y captura los nombres de paquetes.
2. Compara con nombres de `extensions/*/package.json`.
3. Publica solo la **intersección** (ya en npm).

Lista actual de plugins npm (actualiza según sea necesario):

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/discord
- @openclaw/feishu
- @openclaw/lobster
- @openclaw/matrix
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/voice-call
- @openclaw/zalo
- @openclaw/zalouser

Las notas de lanzamiento también deben mencionar **nuevos plugins empaquetados opcionales** que **no están
activados por defecto** (ejemplo: `tlon`).
