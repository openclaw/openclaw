---
summary: "Plugin de Zalo Personal: inicio de sesión por QR + mensajería vía zca-cli (instalación del plugin + configuración del canal + CLI + herramienta)"
read_when:
  - Quiere soporte de Zalo Personal (no oficial) en OpenClaw
  - Está configurando o desarrollando el plugin zalouser
title: "Plugin de Zalo Personal"
---

# Zalo Personal (plugin)

Soporte de Zalo Personal para OpenClaw mediante un plugin, usando `zca-cli` para automatizar una cuenta normal de usuario de Zalo.

> **Advertencia:** La automatización no oficial puede provocar la suspensión o el baneo de la cuenta. Úselo bajo su propio riesgo.

## Naming

El id del canal es `zalouser` para dejar explícito que esto automatiza una **cuenta personal de usuario de Zalo** (no oficial). Mantenemos `zalo` reservado para una posible integración futura con la API oficial de Zalo.

## Dónde se ejecuta

Este plugin se ejecuta **dentro del proceso del Gateway**.

Si utiliza un Gateway remoto, instálelo y configúrelo en la **máquina que ejecuta el Gateway**, y luego reinicie el Gateway.

## Instalación

### Opción A: instalar desde npm

```bash
openclaw plugins install @openclaw/zalouser
```

Reinicie el Gateway después.

### Opción B: instalar desde una carpeta local (dev)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

Reinicie el Gateway después.

## Requisito previo: zca-cli

La máquina del Gateway debe tener `zca` en `PATH`:

```bash
zca --version
```

## Configuración

La configuración del canal se encuentra en `channels.zalouser` (no en `plugins.entries.*`):

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

## Herramienta del Agente

Nombre de la herramienta: `zalouser`

Acciones: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
