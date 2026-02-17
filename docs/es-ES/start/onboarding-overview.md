---
summary: "Resumen de opciones y flujos de incorporación de OpenClaw"
read_when:
  - Eligiendo una ruta de incorporación
  - Configurando un nuevo entorno
title: "Resumen de Incorporación"
sidebarTitle: "Resumen de Incorporación"
---

# Resumen de Incorporación

OpenClaw soporta múltiples rutas de incorporación dependiendo de dónde ejecuta el Gateway
y cómo prefieres configurar los proveedores.

## Elige tu ruta de incorporación

- **Asistente CLI** para macOS, Linux y Windows (vía WSL2).
- **App macOS** para una primera ejecución guiada en Macs Apple Silicon o Intel.

## Asistente de incorporación CLI

Ejecuta el asistente en una terminal:

```bash
openclaw onboard
```

Usa el asistente CLI cuando quieras control completo del Gateway, espacio de trabajo,
canales y habilidades. Documentación:

- [Asistente de Incorporación (CLI)](/start/wizard)
- [Comando `openclaw onboard`](/cli/onboard)

## Incorporación de la app macOS

Usa la app OpenClaw cuando quieras una configuración completamente guiada en macOS. Documentación:

- [Incorporación (App macOS)](/start/onboarding)

## Proveedor Personalizado

Si necesitas un endpoint que no está listado, incluyendo proveedores alojados que
exponen APIs estándar de OpenAI o Anthropic, elige **Proveedor Personalizado** en el
asistente CLI. Se te pedirá:

- Elegir compatible con OpenAI, compatible con Anthropic o **Desconocido** (auto-detectar).
- Ingresar una URL base y clave API (si es requerida por el proveedor).
- Proporcionar un ID de modelo y alias opcional.
- Elegir un ID de Endpoint para que múltiples endpoints personalizados puedan coexistir.

Para pasos detallados, sigue la documentación de incorporación CLI arriba.
