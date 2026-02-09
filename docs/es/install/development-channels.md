---
summary: "Canales estable, beta y dev: semántica, cambio y etiquetado"
read_when:
  - Desea cambiar entre estable/beta/dev
  - Está etiquetando o publicando versiones preliminares
title: "Canales de desarrollo"
---

# Canales de desarrollo

Última actualización: 2026-01-21

OpenClaw ofrece tres canales de actualización:

- **stable**: npm dist-tag `latest`.
- **beta**: npm dist-tag `beta` (compilaciones en prueba).
- **dev**: cabeza móvil de `main` (git). npm dist-tag: `dev` (cuando se publica).

Publicamos compilaciones en **beta**, las probamos y luego **promovemos una compilación validada a `latest`**
sin cambiar el número de versión; los dist-tags son la fuente de verdad para las instalaciones de npm.

## Cambio de canales

Checkout de Git:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` hacen checkout de la etiqueta coincidente más reciente (a menudo la misma etiqueta).
- `dev` cambia a `main` y rebasea sobre el upstream.

Instalación global con npm/pnpm:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

Esto se actualiza mediante el dist-tag de npm correspondiente (`latest`, `beta`, `dev`).

Cuando **explícitamente** cambia de canal con `--channel`, OpenClaw también alinea
el método de instalación:

- `dev` garantiza un checkout de git (predeterminado `~/openclaw`, sobrescriba con `OPENCLAW_GIT_DIR`),
  lo actualiza e instala la CLI global desde ese checkout.
- `stable`/`beta` instalan desde npm usando el dist-tag coincidente.

Consejo: si desea stable + dev en paralelo, mantenga dos clones y apunte su Gateway al estable.

## Plugins y canales

Cuando cambia de canal con `openclaw update`, OpenClaw también sincroniza las fuentes de plugins:

- `dev` prefiere los plugins incluidos desde el checkout de git.
- `stable` y `beta` restauran los paquetes de plugins instalados desde npm.

## Mejores prácticas de etiquetado

- Etiquete las versiones a las que desea que lleguen los checkouts de git (`vYYYY.M.D` o `vYYYY.M.D-<patch>`).
- Mantenga las etiquetas inmutables: nunca mueva ni reutilice una etiqueta.
- Los dist-tags de npm siguen siendo la fuente de verdad para las instalaciones de npm:
  - `latest` → stable
  - `beta` → compilación candidata
  - `dev` → instantánea de main (opcional)

## Disponibilidad de la app de macOS

Las compilaciones beta y dev pueden **no** incluir una versión de la app de macOS. No hay problema:

- La etiqueta de git y el dist-tag de npm aún pueden publicarse.
- Indique “sin compilación de macOS para esta beta” en las notas de la versión o el registro de cambios.
