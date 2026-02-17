---
title: "Solución de Problemas del Navegador en Linux"
description: "Guía de solución de problemas para problemas de automatización del navegador en Linux"
---

## Descripción General

Esta guía cubre problemas comunes y soluciones al ejecutar la automatización del navegador de OpenClaw en sistemas Linux.

## Problemas Comunes

### Falta el Ejecutable del Navegador

**Síntoma**: Error indicando que no se puede encontrar el ejecutable del navegador.

**Solución**: Instala las dependencias del navegador:

```bash
# Para Chromium/Chrome
openclaw browser install

# O instala manualmente
npx playwright install chromium
npx playwright install-deps chromium
```

### Faltan Dependencias del Sistema

**Síntoma**: El navegador falla al lanzarse con errores sobre bibliotecas compartidas faltantes.

**Solución**: Instala las dependencias del sistema requeridas:

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2

# Fedora/RHEL
sudo dnf install -y \
    nss \
    nspr \
    atk \
    at-spi2-atk \
    cups-libs \
    libdrm \
    dbus-libs \
    libxkbcommon \
    libXcomposite \
    libXdamage \
    libXfixes \
    libXrandr \
    mesa-libgbm \
    alsa-lib
```

### Problemas de Permisos

**Síntoma**: Errores de permiso denegado al acceder a recursos del navegador.

**Solución**: Asegúrate de que tu usuario tenga los permisos adecuados:

```bash
# Verifica la propiedad del directorio de OpenClaw
ls -la ~/.openclaw

# Corrige permisos si es necesario
chmod -R u+rw ~/.openclaw
```

### Problemas del Navegador en Modo Headless

**Síntoma**: El navegador funciona en modo con cabeza pero falla en modo headless.

**Solución**: Algunas distribuciones de Linux requieren dependencias adicionales para el modo headless:

```bash
# Instala Xvfb para framebuffer virtual X
sudo apt-get install -y xvfb

# Ejecuta OpenClaw con Xvfb
xvfb-run openclaw browser start
```

### Problemas de Sandbox

**Síntoma**: Errores relacionados con el sandbox del navegador, especialmente en contenedores.

**Solución**: Deshabilita el sandbox del navegador (solo para entornos de desarrollo):

```bash
# Configura la variable de entorno
export OPENCLAW_BROWSER_NO_SANDBOX=1

# O pasa el flag al comando
openclaw browser start --no-sandbox
```

**Advertencia**: Deshabilitar el sandbox reduce la seguridad. Solo usa esto en entornos confiables.

### Problemas Específicos de Docker

**Síntoma**: El navegador falla al ejecutarse en contenedores Docker.

**Solución**: Asegúrate de que tu Dockerfile incluya todas las dependencias:

```dockerfile
# Ejemplo de Dockerfile para OpenClaw con soporte de navegador
FROM node:20-slim

# Instala dependencias del navegador
RUN apt-get update && apt-get install -y \
    chromium \
    libnss3 \
    libxss1 \
    libasound2 \
    fonts-liberation \
    libappindicator3-1 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Configura OpenClaw
ENV OPENCLAW_BROWSER_NO_SANDBOX=1
```

## Obtener Ayuda Adicional

Si continúas experimentando problemas:

1. Ejecuta el diagnóstico de OpenClaw:
   ```bash
   openclaw doctor
   ```

2. Verifica los logs del navegador:
   ```bash
   cat ~/.openclaw/logs/browser.log
   ```

3. Reporta el problema en [GitHub Issues](https://github.com/openclaw/openclaw/issues) con:
   - Versión de tu sistema operativo
   - Salida de `openclaw doctor`
   - Logs relevantes del navegador
   - Pasos para reproducir el problema
