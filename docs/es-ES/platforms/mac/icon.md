---
title: Icono de la App
description: Gestión y personalización del icono de la app de macOS
---

# Icono de la App

El icono de la app de macOS de OpenClaw aparece en múltiples ubicaciones:

- Dock (cuando la app está en ejecución)
- Barra de menú (cuando el modo de barra de menú está habilitado)
- Finder (icono de la aplicación)

## Conjuntos de Iconos

### Icono Principal de la App

Ubicación: `apps/macos/Sources/OpenClaw/Resources/Assets.xcassets/AppIcon.appiconset/`

Tamaños requeridos:
- 16x16, 32x32, 64x64, 128x128, 256x256, 512x512, 1024x1024
- Variantes @1x y @2x para la mayoría de tamaños

### Icono de la Barra de Menú

Ubicación: `apps/macos/Sources/OpenClaw/Resources/Assets.xcassets/MenuBarIcon.imageset/`

Especificaciones:
- Plantilla monocromática (se adapta al tema del sistema)
- Tamaños: 16x16@1x, 32x32@2x
- Formato: PDF o PNG con canal alfa

## Personalización

### Cambiar el Icono de la App

1. Prepara los recursos del icono en todos los tamaños requeridos
2. Arrastra y suelta en el conjunto de iconos de Xcode
3. Reconstruye la app

### Cambiar el Icono de la Barra de Menú

1. Crea una imagen de plantilla monocromática
2. Añade al conjunto de imágenes MenuBarIcon
3. La app recargará automáticamente el nuevo icono
