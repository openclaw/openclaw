---
summary: "Plugin de Zalo Personal: inicio de sesión con QR + mensajería vía zca-cli (instalación de plugin + configuración de canal + CLI + herramienta)"
read_when:
  - Quieres soporte de Zalo Personal (no oficial) en OpenClaw
  - Estás configurando o desarrollando el plugin zalouser
title: "Plugin de Zalo Personal"
---

# Zalo Personal (plugin)

Soporte de Zalo Personal para OpenClaw mediante un plugin, usando `zca-cli` para automatizar una cuenta de usuario normal de Zalo.

> **Advertencia:** La automatización no oficial puede llevar a suspensión/prohibición de cuenta. Úsalo bajo tu propio riesgo.

## Nomenclatura

El id del canal es `zalouser` para dejar explícito que esto automatiza una **cuenta de usuario personal de Zalo** (no oficial). Mantenemos `zalo` reservado para una posible futura integración de API oficial de Zalo.

## Dónde se ejecuta

Este plugin se ejecuta **dentro del proceso del Gateway**.

Si usas un Gateway remoto, instálalo/configúralo en la **máquina que ejecuta el Gateway**, luego reinicia el Gateway.

## Instalación

### Opción A: instalar desde npm

```bash
openclaw plugins install @openclaw/zalouser
```

Reinicia el Gateway después.

### Opción B: instalar desde una carpeta local (dev)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

Reinicia el Gateway después.

## Requisito previo: zca-cli

La máquina del Gateway debe tener `zca` en `PATH`:

```bash
zca --version
```

## Configuración

La configuración del canal se encuentra bajo `channels.zalouser` (no `plugins.entries.*`):

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

## CLI

```bash
openclaw channels login --channel zalouser
openclaw channels logout --channel zalouser
openclaw channels status --probe
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
openclaw directory peers list --channel zalouser --query "name"
```

## Herramienta de agente

Nombre de herramienta: `zalouser`

Acciones: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
