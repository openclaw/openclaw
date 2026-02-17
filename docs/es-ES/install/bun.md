---
title: Instalar desde Código Fuente (Bun)
description: Instalar OpenClaw desde código fuente usando Bun
icon: rabbit-running
---

OpenClaw soporta tanto **Node** como **Bun** para desarrollo e instalación desde código fuente.

<Note>
La instalación con Bun es **opcional**. Puedes usar Node y pnpm si lo prefieres.
</Note>

## Instalar Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

Luego reinicia tu terminal o ejecuta:

```bash
source ~/.bashrc  # o ~/.zshrc si usas zsh
```

## Clonar e Instalar Dependencias

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
bun install
```

## Ejecutar el CLI en Modo Desarrollo

```bash
bun dev <command>
# Ejemplo:
bun dev gateway run
```

## Construir y Ejecutar Producción

```bash
bun run build
bun dist/cli.js <command>
```

O instala globalmente desde el directorio fuente:

```bash
npm install -g .
openclaw <command>
```

## Scripts Comunes

```bash
bun test          # Ejecutar pruebas
bun run build     # Construir proyecto
bun run check     # Lint + formato
bun dev           # Ejecutar CLI en modo dev
```

## Soporte de Lockfile

OpenClaw mantiene tanto `pnpm-lock.yaml` como `bun.lockb`. Ambos funcionan; usa el que prefieras.

Si actualizas dependencias con Bun, asegúrate de que `pnpm install` aún funcione (y viceversa).

## Próximos Pasos

<CardGroup cols={2}>
  <Card title="Configuración" icon="gear" href="/es-ES/configuration">
    Configurar tu servidor OpenClaw
  </Card>
  <Card title="Ejecutar el Gateway" icon="tower-broadcast" href="/es-ES/gateway/running">
    Iniciar el servidor gateway
  </Card>
</CardGroup>
