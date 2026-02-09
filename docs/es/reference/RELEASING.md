---
summary: "Lista de verificación paso a paso para el lanzamiento de npm + app macOS"
read_when:
  - Preparar un nuevo lanzamiento de npm
  - Preparar un nuevo lanzamiento de la app macOS
  - Verificar metadatos antes de publicar
---

# Lista de verificación de lanzamiento (npm + macOS)

Use `pnpm` (Node 22+) desde la raíz del repositorio. Mantenga el árbol de trabajo limpio antes de etiquetar/publicar.

## Activador del operador

Cuando el operador diga “release”, haga inmediatamente este preflight (sin preguntas adicionales a menos que esté bloqueado):

- Lea este documento y `docs/platforms/mac/release.md`.
- Cargue las variables de entorno desde `~/.profile` y confirme que `SPARKLE_PRIVATE_KEY_FILE` + las variables de App Store Connect estén configuradas (SPARKLE_PRIVATE_KEY_FILE debe vivir en `~/.profile`).
- Use las claves de Sparkle de `~/Library/CloudStorage/Dropbox/Backup/Sparkle` si es necesario.

1. **Versión y metadatos**

- [ ] Aumente la versión de `package.json` (p. ej., `2026.1.29`).
- [ ] Ejecute `pnpm plugins:sync` para alinear las versiones de los paquetes de extensiones + los changelogs.
- [ ] Actualice las cadenas de CLI/versión: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) y el user agent de Baileys en [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts).
- [ ] Confirme los metadatos del paquete (nombre, descripción, repositorio, palabras clave, licencia) y que el mapa de `bin` apunte a [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) para `openclaw`.
- [ ] Si cambiaron dependencias, ejecute `pnpm install` para que `pnpm-lock.yaml` esté actualizado.

2. **Build y artefactos**

- [ ] Si cambiaron las entradas de A2UI, ejecute `pnpm canvas:a2ui:bundle` y haga commit de cualquier [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js) actualizado.
- [ ] `pnpm run build` (regenera `dist/`).
- [ ] Verifique que el paquete npm `files` incluya todas las carpetas `dist/*` requeridas (en particular `dist/node-host/**` y `dist/acp/**` para node sin interfaz + la CLI de ACP).
- [ ] Confirme que `dist/build-info.json` exista e incluya el hash `commit` esperado (el banner de la CLI lo usa para instalaciones de npm).
- [ ] Opcional: `npm pack --pack-destination /tmp` después del build; inspeccione el contenido del tarball y consérvelo para el release de GitHub (no lo haga commit).

3. **Changelog y docs**

- [ ] Actualice `CHANGELOG.md` con destacados orientados al usuario (cree el archivo si falta); mantenga las entradas estrictamente en orden descendente por versión.
- [ ] Asegúrese de que los ejemplos/flags del README coincidan con el comportamiento actual de la CLI (en particular comandos u opciones nuevas).

4. **Validación**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (o `pnpm test:coverage` si necesita salida de cobertura)
- [ ] `pnpm release:check` (verifica el contenido de npm pack)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (prueba de humo de instalación en Docker, ruta rápida; requerida antes del lanzamiento)
  - Si se sabe que el lanzamiento npm inmediatamente anterior está roto, configure `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` o `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` para el paso de preinstall.
- [ ] (Opcional) Prueba de humo del instalador completo (agrega cobertura de usuario no root + CLI): `pnpm test:install:smoke`
- [ ] (Opcional) E2E del instalador (Docker, ejecuta `curl -fsSL https://openclaw.ai/install.sh | bash`, hace onboarding y luego ejecuta llamadas reales de herramientas):
  - `pnpm test:install:e2e:openai` (requiere `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (requiere `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (requiere ambas claves; ejecuta ambos proveedores)
- [ ] (Opcional) Verifique puntualmente el Gateway web si sus cambios afectan rutas de envío/recepción.

5. **App macOS (Sparkle)**

- [ ] Compile y firme la app macOS, luego comprímala en zip para distribución.
- [ ] Genere el appcast de Sparkle (notas HTML vía [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)) y actualice `appcast.xml`.
- [ ] Mantenga listo el zip de la app (y el zip dSYM opcional) para adjuntarlo al release de GitHub.
- [ ] Siga [macOS release](/platforms/mac/release) para los comandos exactos y las variables de entorno requeridas.
  - `APP_BUILD` debe ser numérico y monótono (sin `-beta`) para que Sparkle compare versiones correctamente.
  - Si va a notarizar, use el perfil de llavero `openclaw-notary` creado a partir de las variables de entorno de la API de App Store Connect (ver [macOS release](/platforms/mac/release)).

6. **Publicar (npm)**

- [ ] Confirme que el estado de git esté limpio; haga commit y push según sea necesario.
- [ ] `npm login` (verifique 2FA) si es necesario.
- [ ] `npm publish --access public` (use `--tag beta` para pre-releases).
- [ ] Verifique el registro: `npm view openclaw version`, `npm view openclaw dist-tags` y `npx -y openclaw@X.Y.Z --version` (o `--help`).

### Solución de problemas (notas del lanzamiento 2.0.0-beta2)

- **npm pack/publish se cuelga o produce un tarball enorme**: el bundle de la app macOS en `dist/OpenClaw.app` (y los zips de release) se incluyen en el paquete. Corríjalo permitiendo explícitamente el contenido de publicación vía `package.json` `files` (incluya subdirectorios dist, docs, skills; excluya bundles de apps). Confirme con `npm pack --dry-run` que `dist/OpenClaw.app` no esté listado.
- **bucle de npm auth web para dist-tags**: use autenticación legacy para obtener un prompt de OTP:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **La verificación de `npx` falla con `ECOMPROMISED: Lock compromised`**: reintente con una caché fresca:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **La etiqueta necesita re-apuntarse tras un arreglo tardío**: fuerce la actualización y empuje la etiqueta, luego asegúrese de que los artefactos del release de GitHub aún coincidan:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **Release de GitHub + appcast**

- [ ] Etiquete y haga push: `git tag vX.Y.Z && git push origin vX.Y.Z` (o `git push --tags`).
- [ ] Cree/actualice el release de GitHub para `vX.Y.Z` con **título `openclaw X.Y.Z`** (no solo la etiqueta); el cuerpo debe incluir la sección **completa** del changelog para esa versión (Destacados + Cambios + Correcciones), en línea (sin enlaces sueltos), y **no debe repetir el título dentro del cuerpo**.
- [ ] Adjunte artefactos: tarball `npm pack` (opcional), `OpenClaw-X.Y.Z.zip` y `OpenClaw-X.Y.Z.dSYM.zip` (si se generó).
- [ ] Haga commit del `appcast.xml` actualizado y haga push (Sparkle se alimenta desde main).
- [ ] Desde un directorio temporal limpio (sin `package.json`), ejecute `npx -y openclaw@X.Y.Z send --help` para confirmar que la instalación/los entrypoints de la CLI funcionan.
- [ ] Anuncie/comparta las notas del lanzamiento.

## Alcance de publicación de plugins (npm)

Solo publicamos **plugins npm existentes** bajo el scope `@openclaw/*`. Los plugins
incluidos que no están en npm permanecen **solo en el árbol de disco** (aun así se envían en
`extensions/**`).

Proceso para derivar la lista:

1. `npm search @openclaw --json` y capture los nombres de los paquetes.
2. Compare con los nombres de `extensions/*/package.json`.
3. Publique solo la **intersección** (ya en npm).

Lista actual de plugins npm (actualice según sea necesario):

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

Las notas del lanzamiento también deben mencionar **nuevos plugins opcionales incluidos** que **no
están activados por defecto** (ejemplo: `tlon`).
