---
summary: "Referencia completa del flujo de incorporación de la CLI, configuración de autenticación/modelos, salidas e internals"
read_when:
  - Necesita un comportamiento detallado para la incorporación de openclaw
  - Está depurando los resultados de la incorporación o integrando clientes de incorporación
title: "Referencia de incorporación por CLI"
sidebarTitle: "Referencia de CLI"
---

# Referencia de incorporación por CLI

Esta página es la referencia completa para `openclaw onboard`.
Para la guía corta, consulte [Asistente de incorporación (CLI)](/start/wizard).

## Qué hace el asistente

El modo local (predeterminado) lo guía a través de:

- Configuración de modelo y autenticación (OAuth de suscripción OpenAI Code, clave de API de Anthropic o token de configuración, además de opciones de MiniMax, GLM, Moonshot y AI Gateway)
- Ubicación del espacio de trabajo y archivos de arranque
- Configuración del Gateway (puerto, bind, autenticación, Tailscale)
- Canales y proveedores (Telegram, WhatsApp, Discord, Google Chat, plugin de Mattermost, Signal)
- Instalación del daemon (LaunchAgent o unidad de usuario systemd)
- Revisión de salud
- Configuración de Skills

El modo remoto configura esta máquina para conectarse a un gateway en otro lugar.
No instala ni modifica nada en el host remoto.

## Detalles del flujo local

<Steps>
  <Step title="Existing config detection">
    - Si existe `~/.openclaw/openclaw.json`, elija Mantener, Modificar o Restablecer.
    - Volver a ejecutar el asistente no borra nada a menos que elija explícitamente Restablecer (o pase `--reset`).
    - Si la configuración es inválida o contiene claves heredadas, el asistente se detiene y le pide que ejecute `openclaw doctor` antes de continuar.
    - El restablecimiento usa `trash` y ofrece alcances:
      - Solo configuración
      - Configuración + credenciales + sesiones
      - Restablecimiento completo (también elimina el espacio de trabajo)  
</Step>
  <Step title="Model and auth">
    - La matriz completa de opciones está en [Opciones de autenticación y modelos](#auth-and-model-options).
  </Step>
  <Step title="Workspace">
    - Predeterminado `~/.openclaw/workspace` (configurable).
    - Inicializa los archivos del espacio de trabajo necesarios para el ritual de arranque de la primera ejecución.
    - Diseño del espacio de trabajo: [Espacio de trabajo del Agente](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Solicita puerto, bind, modo de autenticación y exposición por Tailscale.
    - Recomendado: mantenga la autenticación por token habilitada incluso para loopback para que los clientes WS locales deban autenticarse.
    - Deshabilite la autenticación solo si confía plenamente en todos los procesos locales.
    - Los binds que no son loopback aún requieren autenticación.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): inicio de sesión por QR opcional
    - [Telegram](/channels/telegram): token del bot
    - [Discord](/channels/discord): token del bot
    - [Google Chat](/channels/googlechat): JSON de cuenta de servicio + audiencia del webhook
    - Plugin de [Mattermost](/channels/mattermost): token del bot + URL base
    - [Signal](/channels/signal): instalación opcional de `signal-cli` + configuración de cuenta
    - [BlueBubbles](/channels/bluebubbles): recomendado para iMessage; URL del servidor + contraseña + webhook
    - [iMessage](/channels/imessage): ruta CLI heredada `imsg` + acceso a la base de datos
    - Seguridad de mensajes directos: el valor predeterminado es el emparejamiento. El primer mensaje directo envía un código; apruébelo mediante
      `openclaw pairing approve <channel><code>` o use listas de permitidos.
  </Step><code>` o use listas de permitidos.
  </Step>
  <Step title="Instalación del daemon">
    - macOS: LaunchAgent
      - Requiere una sesión de usuario iniciada; para modo headless, use un LaunchDaemon personalizado (no incluido).
    - Linux y Windows mediante WSL2: unidad de usuario systemd
      - El asistente intenta `loginctl enable-linger <user>` para que el gateway permanezca activo tras cerrar sesión.
      - Puede solicitar sudo (escribe `/var/lib/systemd/linger`); primero lo intenta sin sudo.
    - Selección de runtime: Node (recomendado; requerido para WhatsApp y Telegram). Bun no es recomendado.
  </Step>
  <Step title="Verificación de estado">
    - Inicia el gateway (si es necesario) y ejecuta `openclaw health`.
    - `openclaw status --deep` agrega sondas de estado del gateway a la salida de estado.
  </Step>
  <Step title="Skills">
    - Lee las skills disponibles y verifica los requisitos.
    - Le permite elegir el gestor de paquetes de Node: npm o pnpm (bun no es recomendado).
    - Instala dependencias opcionales (algunas usan Homebrew en macOS).
  </Step>
  <Step title="Finalizar">
    - Resumen y siguientes pasos, incluidas opciones de apps para iOS, Android y macOS.
  </Step>
</Steps>

<Note>
Si no se detecta una GUI, el asistente imprime instrucciones de reenvío de puertos SSH para la Control UI en lugar de abrir un navegador.
Si faltan los assets de la Control UI, el asistente intenta construirlos; el fallback es `pnpm ui:build` (instala automáticamente las dependencias de la UI).
</Note>

## Detalles del modo remoto

El modo remoto configura esta máquina para conectarse a un gateway en otro lugar.

<Info>
El modo remoto no instala ni modifica nada en el host remoto.
</Info>

Lo que configura:

- URL del gateway remoto (`ws://...`)
- Token si la autenticación del gateway remoto es requerida (recomendado)

<Note>
- Si el gateway es solo loopback, use túneles SSH o una tailnet.
- Pistas de descubrimiento:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Opciones de autenticación y modelos

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    Usa `ANTHROPIC_API_KEY` si está presente o solicita una clave, y luego la guarda para uso del daemon.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: verifica el ítem del Llavero "Claude Code-credentials"
    - Linux y Windows: reutiliza `~/.claude/.credentials.json` si está presente

    ```
    En macOS, elija "Permitir siempre" para que los inicios de launchd no se bloqueen.
    ```

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    Ejecute `claude setup-token` en cualquier máquina y luego pegue el token.
    Puede nombrarlo; en blanco usa el valor predeterminado.
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    Si existe `~/.codex/auth.json`, el asistente puede reutilizarlo.
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    Flujo en el navegador; pegue `code#state`.

    ```
    Establece `agents.defaults.model` en `openai-codex/gpt-5.3-codex` cuando el modelo no está configurado o es `openai/*`.
    ```

  </Accordion>
  <Accordion title="OpenAI API key">
    Usa `OPENAI_API_KEY` si está presente o solicita una clave, y luego la guarda en
    `~/.openclaw/.env` para que launchd pueda leerla.

    ```
    Establece `agents.defaults.model` en `openai/gpt-5.1-codex` cuando el modelo no está configurado, es `openai/*` o `openai-codex/*`.
    ```

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    Solicita `XAI_API_KEY` y configura xAI como proveedor de modelos.
  </Accordion>
  <Accordion title="OpenCode Zen">
    Solicita `OPENCODE_API_KEY` (o `OPENCODE_ZEN_API_KEY`).
    URL de configuración: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">
    Almacena la clave por usted.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    Solicita `AI_GATEWAY_API_KEY`.
    Más detalles: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Solicita ID de cuenta, ID del gateway y `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    Más detalles: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    La configuración se escribe automáticamente.
    Más detalles: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    Solicita `SYNTHETIC_API_KEY`.
    Más detalles: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    Las configuraciones de Moonshot (Kimi K2) y Kimi Coding se escriben automáticamente.
    Más detalles: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Skip">
    Deja la autenticación sin configurar.
  </Accordion>
</AccordionGroup>

Comportamiento del modelo:

- Elija el modelo predeterminado entre las opciones detectadas o ingrese proveedor y modelo manualmente.
- El asistente ejecuta una verificación del modelo y advierte si el modelo configurado es desconocido o le falta autenticación.

Rutas de credenciales y perfiles:

- Credenciales OAuth: `~/.openclaw/credentials/oauth.json`
- Perfiles de autenticación (claves de API + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
Consejo para headless y servidores: complete OAuth en una máquina con navegador y luego copie
`~/.openclaw/credentials/oauth.json` (o `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
al host del Gateway.
</Note>

## Salidas e internals

Campos típicos en `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (si se elige Minimax)
- `gateway.*` (modo, bind, autenticación, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Listas de permitidos de canales (Slack, Discord, Matrix, Microsoft Teams) cuando usted opta por ellas durante las indicaciones (los nombres se resuelven a IDs cuando es posible)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` escribe `agents.list[]` y el opcional `bindings`.

Las credenciales de WhatsApp van en `~/.openclaw/credentials/whatsapp/<accountId>/`.
Las sesiones se almacenan en `~/.openclaw/agents/<agentId>/sessions/`.

<Note>
Algunos canales se entregan como plugins. Cuando se seleccionan durante la incorporación, el asistente
solicita instalar el plugin (npm o ruta local) antes de la configuración del canal.
</Note>

RPC del asistente del Gateway:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

Los clientes (app de macOS y Control UI) pueden renderizar los pasos sin reimplementar la lógica de incorporación.

Comportamiento de configuración de Signal:

- Descarga el asset de la versión apropiada
- Lo almacena en `~/.openclaw/tools/signal-cli/<version>/`
- Escribe `channels.signal.cliPath` en la configuración
- Las compilaciones JVM requieren Java 21
- Se usan compilaciones nativas cuando están disponibles
- Windows usa WSL2 y sigue el flujo de signal-cli de Linux dentro de WSL

## Documentos relacionados

- Centro de incorporación: [Asistente de incorporación (CLI)](/start/wizard)
- Automatización y scripts: [Automatización de la CLI](/start/wizard-cli-automation)
- Referencia de comandos: [`openclaw onboard`](/cli/onboard)
