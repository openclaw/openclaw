---
title: Canales de Desarrollo
description: Elegir entre stable, beta y dev para instalaciones de OpenClaw
icon: code-branch
---

OpenClaw ofrece tres **canales de lanzamiento**:

- **stable** – Lanzamientos etiquetados (ej. `v2026.2.16`)
- **beta** – Prelanzamientos etiquetados (ej. `v2026.2.16-beta.1`)
- **dev** – Rama `main` más reciente (sin etiqueta)

## Instalación Rápida por Canal

<Tabs>
  <Tab title="stable (Recomendado)">
    ```bash
    npm install -g openclaw@latest
    ```
    O usa el instalador de [openclaw.ai/install](https://openclaw.ai/install).

    **Cuándo usar**: Producción, uso diario, máxima estabilidad.
  </Tab>

  <Tab title="beta">
    ```bash
    npm install -g openclaw@beta
    ```

    **Cuándo usar**: Probar próximas características antes del lanzamiento stable, ayudar con pruebas de prelanzamiento.

    <Note>
    Las versiones beta pueden no incluir builds de la aplicación macOS hasta el lanzamiento stable.
    </Note>
  </Tab>

  <Tab title="dev">
    ```bash
    git clone https://github.com/openclaw/openclaw.git
    cd openclaw
    pnpm install
    pnpm dev <command>
    ```

    **Cuándo usar**: Desarrollo, contribuciones, últimas características/correcciones, disposición a encontrar errores.

    <Warning>
    El canal dev puede contener características inestables. Úsalo solo si estás dispuesto a depurar y reportar problemas.
    </Warning>
  </Tab>
</Tabs>

## Cambiar entre Canales

### De stable a beta

```bash
npm install -g openclaw@beta
```

### De beta a stable

```bash
npm install -g openclaw@latest
```

### De cualquier canal a dev

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
```

Luego ejecuta comandos con:

```bash
pnpm dev <command>
```

### De dev a stable/beta

Desinstala la instalación de git y usa npm:

```bash
npm install -g openclaw@latest    # stable
npm install -g openclaw@beta      # beta
```

## Verificar tu Canal Actual

```bash
openclaw version
```

Esto muestra tu versión instalada.

- Si es `YYYY.M.D` (ej. `2026.2.16`), estás en **stable**.
- Si es `YYYY.M.D-beta.N` (ej. `2026.2.16-beta.1`), estás en **beta**.
- Si es un hash de commit o ejecutas desde un directorio git clonado, estás en **dev**.

## Notas de la Aplicación macOS

- **stable**: Incluye builds firmados de la aplicación macOS y actualizaciones automáticas vía Sparkle.
- **beta**: Puede incluir builds de la aplicación macOS (pero no siempre).
- **dev**: Sin aplicación macOS; solo instalación CLI.

## Próximos Pasos

<CardGroup cols={2}>
  <Card title="Actualizando OpenClaw" icon="arrow-up" href="/es-ES/install/updating">
    Mantén tu instalación actualizada
  </Card>
  <Card title="Desinstalación" icon="trash" href="/es-ES/install/uninstall">
    Eliminar OpenClaw
  </Card>
</CardGroup>
