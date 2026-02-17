---
summary: "Referencia completa del flujo de onboarding CLI, configuración de autenticación/modelo, salidas e internos"
read_when:
  - Necesitas el comportamiento detallado de openclaw onboard
  - Estás depurando resultados de onboarding o integrando clientes de onboarding
title: "Referencia CLI de Onboarding"
sidebarTitle: "Referencia CLI"
---

# Referencia CLI de Onboarding

Esta página es la referencia completa para `openclaw onboard`.
Para la guía corta, consulta [Asistente de Onboarding (CLI)](/es-ES/start/wizard).

## Qué hace el asistente

El modo local (predeterminado) te guía a través de:

- Configuración de modelo y autenticación (OAuth de suscripción OpenAI Code, clave API de Anthropic o token de configuración, además de opciones de MiniMax, GLM, Moonshot y AI Gateway)
- Ubicación del workspace y archivos de bootstrap
- Configuración del Gateway (puerto, bind, autenticación, tailscale)
- Canales y proveedores (Telegram, WhatsApp, Discord, Google Chat, plugin de Mattermost, Signal)
- Instalación del daemon (LaunchAgent o unidad de usuario systemd)
- Verificación de salud
- Configuración de skills

El modo remoto configura esta máquina para conectarse a un gateway en otro lugar.
No instala ni modifica nada en el host remoto.

## Detalles del flujo local

<Steps>
  <Step title="Detección de configuración existente">
    - Si `~/.openclaw/openclaw.json` existe, elige Mantener, Modificar o Restablecer.
    - Volver a ejecutar el asistente no borra nada a menos que elijas explícitamente Restablecer (o pases `--reset`).
    - Si la configuración es inválida o contiene claves heredadas, el asistente se detiene y te pide ejecutar `openclaw doctor` antes de continuar.
    - Restablecer usa `trash` y ofrece alcances:
      - Solo configuración
      - Configuración + credenciales + sesiones
      - Restablecimiento completo (también elimina workspace)
  </Step>
  <Step title="Modelo y autenticación">
    - La matriz completa de opciones está en [Opciones de autenticación y modelo](#opciones-de-autenticacion-y-modelo).
  </Step>
  <Step title="Workspace">
    - Predeterminado `~/.openclaw/workspace` (configurable).
    - Inicializa archivos de workspace necesarios para el ritual de bootstrap de primera ejecución.
    - Diseño del workspace: [Workspace del agente](/es-ES/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Solicita puerto, bind, modo de autenticación y exposición de tailscale.
    - Recomendado: mantén la autenticación por token habilitada incluso para loopback para que los clientes WS locales deban autenticarse.
    - Deshabilita la autenticación solo si confías completamente en cada proceso local.
    - Los binds no-loopback aún requieren autenticación.
  </Step>
  <Step title="Canales">
    - [WhatsApp](/es-ES/channels/whatsapp): inicio de sesión QR opcional
    - [Telegram](/es-ES/channels/telegram): token de bot
    - [Discord](/es-ES/channels/discord): token de bot
    - [Google Chat](/es-ES/channels/googlechat): JSON de cuenta de servicio + audiencia de webhook
    - Plugin de [Mattermost](/es-ES/channels/mattermost): token de bot + URL base
    - [Signal](/es-ES/channels/signal): instalación opcional de `signal-cli` + configuración de cuenta
    - [BlueBubbles](/es-ES/channels/bluebubbles): recomendado para iMessage; URL del servidor + contraseña + webhook
    - [iMessage](/es-ES/channels/imessage): ruta CLI heredada `imsg` + acceso a BD
    - Seguridad de DM: el predeterminado es emparejamiento. El primer DM envía un código; aprueba mediante
      `openclaw pairing approve <canal> <código>` o usa listas de permitidos.
  </Step>
  <Step title="Instalación del daemon">
    - macOS: LaunchAgent
      - Requiere sesión de usuario con inicio de sesión; para headless, usa un LaunchDaemon personalizado (no incluido).
    - Linux y Windows mediante WSL2: unidad de usuario systemd
      - El asistente intenta `loginctl enable-linger <usuario>` para que el gateway permanezca activo después del cierre de sesión.
      - Puede solicitar sudo (escribe en `/var/lib/systemd/linger`); primero lo intenta sin sudo.
    - Selección de runtime: Node (recomendado; requerido para WhatsApp y Telegram). Bun no es recomendado.
  </Step>
  <Step title="Verificación de salud">
    - Inicia el gateway (si es necesario) y ejecuta `openclaw health`.
    - `openclaw status --deep` agrega sondas de salud del gateway a la salida de estado.
  </Step>
  <Step title="Skills">
    - Lee los skills disponibles y verifica los requisitos.
    - Te permite elegir el gestor de nodos: npm o pnpm (bun no recomendado).
    - Instala dependencias opcionales (algunos usan Homebrew en macOS).
  </Step>
  <Step title="Finalizar">
    - Resumen y próximos pasos, incluyendo opciones de aplicaciones iOS, Android y macOS.
  </Step>
</Steps>

<Note>
Si no se detecta GUI, el asistente imprime instrucciones de reenvío de puerto SSH para la UI de Control en lugar de abrir un navegador.
Si faltan los recursos de la UI de Control, el asistente intenta compilarlos; la alternativa es `pnpm ui:build` (autoinstala dependencias de UI).
</Note>

## Detalles del modo remoto

El modo remoto configura esta máquina para conectarse a un gateway en otro lugar.

<Info>
El modo remoto no instala ni modifica nada en el host remoto.
</Info>

Lo que configuras:

- URL del gateway remoto (`ws://...`)
- Token si se requiere autenticación del gateway remoto (recomendado)

<Note>
- Si el gateway es solo loopback, usa túnel SSH o una tailnet.
- Sugerencias de descubrimiento:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Opciones de autenticación y modelo

<AccordionGroup>
  <Accordion title="Clave API de Anthropic (recomendado)">
    Usa `ANTHROPIC_API_KEY` si está presente o solicita una clave, luego la guarda para uso del daemon.
  </Accordion>
  <Accordion title="OAuth de Anthropic (Claude Code CLI)">
    - macOS: verifica el elemento del Llavero "Claude Code-credentials"
    - Linux y Windows: reutiliza `~/.claude/.credentials.json` si está presente

    En macOS, elige "Permitir siempre" para que los inicios de launchd no se bloqueen.

  </Accordion>
  <Accordion title="Token de Anthropic (pegado setup-token)">
    Ejecuta `claude setup-token` en cualquier máquina, luego pega el token.
    Puedes nombrarlo; en blanco usa el predeterminado.
  </Accordion>
  <Accordion title="Suscripción OpenAI Code (reutilización Codex CLI)">
    Si `~/.codex/auth.json` existe, el asistente puede reutilizarlo.
  </Accordion>
  <Accordion title="Suscripción OpenAI Code (OAuth)">
    Flujo de navegador; pega `code#state`.

    Establece `agents.defaults.model` en `openai-codex/gpt-5.3-codex` cuando el modelo no está establecido o es `openai/*`.

  </Accordion>
  <Accordion title="Clave API de OpenAI">
    Usa `OPENAI_API_KEY` si está presente o solicita una clave, luego la guarda en
    `~/.openclaw/.env` para que launchd pueda leerla.

    Establece `agents.defaults.model` en `openai/gpt-5.1-codex` cuando el modelo no está establecido, es `openai/*` o `openai-codex/*`.

  </Accordion>
  <Accordion title="Clave API de xAI (Grok)">
    Solicita `XAI_API_KEY` y configura xAI como proveedor de modelo.
  </Accordion>
  <Accordion title="OpenCode Zen">
    Solicita `OPENCODE_API_KEY` (o `OPENCODE_ZEN_API_KEY`).
    URL de configuración: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="Clave API (genérica)">
    Almacena la clave por ti.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    Solicita `AI_GATEWAY_API_KEY`.
    Más detalle: [Vercel AI Gateway](/es-ES/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Solicita ID de cuenta, ID de gateway y `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    Más detalle: [Cloudflare AI Gateway](/es-ES/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    La configuración se escribe automáticamente.
    Más detalle: [MiniMax](/es-ES/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (compatible con Anthropic)">
    Solicita `SYNTHETIC_API_KEY`.
    Más detalle: [Synthetic](/es-ES/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot y Kimi Coding">
    Las configuraciones de Moonshot (Kimi K2) y Kimi Coding se escriben automáticamente.
    Más detalle: [Moonshot AI (Kimi + Kimi Coding)](/es-ES/providers/moonshot).
  </Accordion>
  <Accordion title="Proveedor personalizado">
    Funciona con endpoints compatibles con OpenAI y Anthropic.

    Flags no interactivos:
    - `--auth-choice custom-api-key`
    - `--custom-base-url`
    - `--custom-model-id`
    - `--custom-api-key` (opcional; recurre a `CUSTOM_API_KEY`)
    - `--custom-provider-id` (opcional)
    - `--custom-compatibility <openai|anthropic>` (opcional; predeterminado `openai`)

  </Accordion>
  <Accordion title="Omitir">
    Deja la autenticación sin configurar.
  </Accordion>
</AccordionGroup>

Comportamiento del modelo:

- Elige el modelo predeterminado de las opciones detectadas, o ingresa proveedor y modelo manualmente.
- El asistente ejecuta una verificación del modelo y advierte si el modelo configurado es desconocido o falta autenticación.

Rutas de credenciales y perfil:

- Credenciales OAuth: `~/.openclaw/credentials/oauth.json`
- Perfiles de autenticación (claves API + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
Consejo para headless y servidor: completa OAuth en una máquina con navegador, luego copia
`~/.openclaw/credentials/oauth.json` (o `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
al host del gateway.
</Note>

## Salidas e internos

Campos típicos en `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (si se elige Minimax)
- `gateway.*` (mode, bind, auth, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Listas de permitidos de canales (Slack, Discord, Matrix, Microsoft Teams) cuando optas por ellas durante las solicitudes (los nombres se resuelven a IDs cuando es posible)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` escribe `agents.list[]` y `bindings` opcionales.

Las credenciales de WhatsApp van en `~/.openclaw/credentials/whatsapp/<accountId>/`.
Las sesiones se almacenan en `~/.openclaw/agents/<agentId>/sessions/`.

<Note>
Algunos canales se entregan como plugins. Cuando se seleccionan durante el onboarding, el asistente
solicita instalar el plugin (npm o ruta local) antes de la configuración del canal.
</Note>

RPC del asistente del Gateway:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

Los clientes (aplicación macOS y UI de Control) pueden renderizar pasos sin reimplementar la lógica de onboarding.

Comportamiento de configuración de Signal:

- Descarga el recurso de lanzamiento apropiado
- Lo almacena en `~/.openclaw/tools/signal-cli/<version>/`
- Escribe `channels.signal.cliPath` en la configuración
- Las compilaciones JVM requieren Java 21
- Las compilaciones nativas se usan cuando están disponibles
- Windows usa WSL2 y sigue el flujo de signal-cli de Linux dentro de WSL

## Documentación relacionada

- Hub de onboarding: [Asistente de Onboarding (CLI)](/es-ES/start/wizard)
- Automatización y scripts: [Automatización CLI](/es-ES/start/wizard-cli-automation)
- Referencia de comando: [`openclaw onboard`](/es-ES/cli/onboard)
