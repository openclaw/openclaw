---
summary: "Referencia completa para el asistente de incorporación CLI: cada paso, bandera y campo de config"
read_when:
  - Buscando un paso o bandera específica del asistente
  - Automatizando la incorporación con modo no interactivo
  - Depurando comportamiento del asistente
title: "Referencia del Asistente de Incorporación"
sidebarTitle: "Referencia del Asistente"
---

# Referencia del Asistente de Incorporación

Esta es la referencia completa para el asistente CLI `openclaw onboard`.
Para una descripción general de alto nivel, ver [Asistente de Incorporación](/es-ES/start/wizard).

## Detalles del flujo (modo local)

<Steps>
  <Step title="Detección de configuración existente">
    - Si `~/.openclaw/openclaw.json` existe, elige **Mantener / Modificar / Reiniciar**.
    - Re-ejecutar el asistente **no** borra nada a menos que elijas explícitamente **Reiniciar**
      (o pases `--reset`).
    - Si la configuración es inválida o contiene claves heredadas, el asistente se detiene y te pide
      que ejecutes `openclaw doctor` antes de continuar.
    - El reinicio usa `trash` (nunca `rm`) y ofrece alcances:
      - Solo configuración
      - Configuración + credenciales + sesiones
      - Reinicio completo (también elimina espacio de trabajo)
  </Step>
  <Step title="Modelo/Autenticación">
    - **Clave de API de Anthropic (recomendado)**: usa `ANTHROPIC_API_KEY` si está presente o solicita una clave, luego la guarda para uso del daemon.
    - **OAuth de Anthropic (Claude Code CLI)**: en macOS el asistente verifica el elemento de Keychain "Claude Code-credentials" (elige "Permitir siempre" para que los inicios de launchd no se bloqueen); en Linux/Windows reutiliza `~/.claude/.credentials.json` si está presente.
    - **Token de Anthropic (pegar setup-token)**: ejecuta `claude setup-token` en cualquier máquina, luego pega el token (puedes nombrarlo; en blanco = predeterminado).
    - **Suscripción OpenAI Code (Codex) (Codex CLI)**: si existe `~/.codex/auth.json`, el asistente puede reutilizarlo.
    - **Suscripción OpenAI Code (Codex) (OAuth)**: flujo de navegador; pega el `code#state`.
      - Establece `agents.defaults.model` a `openai-codex/gpt-5.2` cuando el modelo no está establecido o es `openai/*`.
    - **Clave de API de OpenAI**: usa `OPENAI_API_KEY` si está presente o solicita una clave, luego la guarda en `~/.openclaw/.env` para que launchd pueda leerla.
    - **Clave de API de xAI (Grok)**: solicita `XAI_API_KEY` y configura xAI como proveedor de modelo.
    - **OpenCode Zen (proxy multi-modelo)**: solicita `OPENCODE_API_KEY` (o `OPENCODE_ZEN_API_KEY`, obténla en https://opencode.ai/auth).
    - **Clave de API**: almacena la clave para ti.
    - **Vercel AI Gateway (proxy multi-modelo)**: solicita `AI_GATEWAY_API_KEY`.
    - Más detalles: [Vercel AI Gateway](/es-ES/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: solicita ID de cuenta, ID de Gateway, y `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - Más detalles: [Cloudflare AI Gateway](/es-ES/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: la configuración se escribe automáticamente.
    - Más detalles: [MiniMax](/es-ES/providers/minimax)
    - **Synthetic (compatible con Anthropic)**: solicita `SYNTHETIC_API_KEY`.
    - Más detalles: [Synthetic](/es-ES/providers/synthetic)
    - **Moonshot (Kimi K2)**: la configuración se escribe automáticamente.
    - **Kimi Coding**: la configuración se escribe automáticamente.
    - Más detalles: [Moonshot AI (Kimi + Kimi Coding)](/es-ES/providers/moonshot)
    - **Omitir**: aún no se configura autenticación.
    - Elige un modelo predeterminado de las opciones detectadas (o ingresa proveedor/modelo manualmente).
    - El asistente ejecuta una verificación de modelo y advierte si el modelo configurado es desconocido o falta autenticación.
    - Las credenciales OAuth viven en `~/.openclaw/credentials/oauth.json`; los perfiles de autenticación viven en `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (claves de API + OAuth).
    - Más detalles: [/es-ES/concepts/oauth](/es-ES/concepts/oauth)
    <Note>
    Consejo sin interfaz/servidor: completa OAuth en una máquina con navegador, luego copia
    `~/.openclaw/credentials/oauth.json` (o `$OPENCLAW_STATE_DIR/credentials/oauth.json`) al
    host del gateway.
    </Note>
  </Step>
  <Step title="Espacio de trabajo">
    - Predeterminado `~/.openclaw/workspace` (configurable).
    - Inicializa los archivos del espacio de trabajo necesarios para el ritual de bootstrap del agente.
    - Diseño completo del espacio de trabajo + guía de respaldo: [Espacio de trabajo del agente](/es-ES/concepts/agent-workspace)
  </Step>
  <Step title="Gateway">
    - Puerto, bind, modo de autenticación, exposición tailscale.
    - Recomendación de autenticación: mantén **Token** incluso para bucle local para que los clientes WS locales deban autenticarse.
    - Deshabilita la autenticación solo si confías completamente en cada proceso local.
    - Los binds no de bucle local aún requieren autenticación.
  </Step>
  <Step title="Canales">
    - [WhatsApp](/es-ES/channels/whatsapp): inicio de sesión QR opcional.
    - [Telegram](/es-ES/channels/telegram): token de bot.
    - [Discord](/es-ES/channels/discord): token de bot.
    - [Google Chat](/es-ES/channels/googlechat): JSON de cuenta de servicio + audiencia de webhook.
    - [Mattermost](/es-ES/channels/mattermost) (plugin): token de bot + URL base.
    - [Signal](/es-ES/channels/signal): instalación opcional de `signal-cli` + configuración de cuenta.
    - [BlueBubbles](/es-ES/channels/bluebubbles): **recomendado para iMessage**; URL del servidor + contraseña + webhook.
    - [iMessage](/es-ES/channels/imessage): ruta CLI heredada `imsg` + acceso a BD.
    - Seguridad de mensajes directos: predeterminado es emparejamiento. El primer mensaje directo envía un código; aprueba vía `openclaw pairing approve <channel> <code>` o usa listas de permitidos.
  </Step>
  <Step title="Instalación de daemon">
    - macOS: LaunchAgent
      - Requiere una sesión de usuario conectada; para sin interfaz, usa un LaunchDaemon personalizado (no incluido).
    - Linux (y Windows vía WSL2): unidad de usuario systemd
      - El asistente intenta habilitar persistencia vía `loginctl enable-linger <user>` para que el Gateway permanezca activo después del cierre de sesión.
      - Puede solicitar sudo (escribe `/var/lib/systemd/linger`); primero intenta sin sudo.
    - **Selección de runtime:** Node (recomendado; requerido para WhatsApp/Telegram). Bun **no es recomendado**.
  </Step>
  <Step title="Verificación de salud">
    - Inicia el Gateway (si es necesario) y ejecuta `openclaw health`.
    - Consejo: `openclaw status --deep` agrega sondas de salud del gateway a la salida de estado (requiere un gateway alcanzable).
  </Step>
  <Step title="Habilidades (recomendado)">
    - Lee las habilidades disponibles y verifica requisitos.
    - Te permite elegir un gestor de nodos: **npm / pnpm** (bun no recomendado).
    - Instala dependencias opcionales (algunas usan Homebrew en macOS).
  </Step>
  <Step title="Finalizar">
    - Resumen + próximos pasos, incluyendo aplicaciones iOS/Android/macOS para características adicionales.
  </Step>
</Steps>

<Note>
Si no se detecta GUI, el asistente imprime instrucciones de reenvío de puerto SSH para la Interfaz de Control en lugar de abrir un navegador.
Si faltan los activos de la Interfaz de Control, el asistente intenta construirlos; el respaldo es `pnpm ui:build` (auto-instala dependencias de UI).
</Note>

## Modo no interactivo

Usa `--non-interactive` para automatizar o script de incorporación:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

Agrega `--json` para un resumen legible por máquina.

<Note>
`--json` **no** implica modo no interactivo. Usa `--non-interactive` (y `--workspace`) para scripts.
</Note>

<AccordionGroup>
  <Accordion title="Ejemplo de Gemini">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Ejemplo de Z.AI">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Ejemplo de Vercel AI Gateway">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Ejemplo de Cloudflare AI Gateway">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Ejemplo de Moonshot">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Ejemplo de Synthetic">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Ejemplo de OpenCode Zen">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

### Agregar agente (no interactivo)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## RPC del asistente del Gateway

El Gateway expone el flujo del asistente sobre RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Los clientes (aplicación macOS, Interfaz de Control) pueden renderizar pasos sin re-implementar la lógica de incorporación.

## Configuración de Signal (signal-cli)

El asistente puede instalar `signal-cli` desde lanzamientos de GitHub:

- Descarga el activo de lanzamiento apropiado.
- Lo almacena bajo `~/.openclaw/tools/signal-cli/<version>/`.
- Escribe `channels.signal.cliPath` en tu configuración.

Notas:

- Las compilaciones JVM requieren **Java 21**.
- Las compilaciones nativas se usan cuando están disponibles.
- Windows usa WSL2; la instalación de signal-cli sigue el flujo de Linux dentro de WSL.

## Qué escribe el asistente

Campos típicos en `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (si se eligió Minimax)
- `gateway.*` (modo, bind, auth, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Listas de permitidos de canales (Slack/Discord/Matrix/Microsoft Teams) cuando optas durante los prompts (los nombres se resuelven a IDs cuando es posible).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` escribe `agents.list[]` y `bindings` opcionales.

Las credenciales de WhatsApp van bajo `~/.openclaw/credentials/whatsapp/<accountId>/`.
Las sesiones se almacenan bajo `~/.openclaw/agents/<agentId>/sessions/`.

Algunos canales se entregan como plugins. Cuando eliges uno durante la incorporación, el asistente
te pedirá instalarlo (npm o una ruta local) antes de que pueda configurarse.

## Documentación relacionada

- Descripción general del asistente: [Asistente de Incorporación](/es-ES/start/wizard)
- Incorporación de aplicación macOS: [Incorporación](/es-ES/start/onboarding)
- Referencia de configuración: [Configuración del Gateway](/es-ES/gateway/configuration)
- Proveedores: [WhatsApp](/es-ES/channels/whatsapp), [Telegram](/es-ES/channels/telegram), [Discord](/es-ES/channels/discord), [Google Chat](/es-ES/channels/googlechat), [Signal](/es-ES/channels/signal), [BlueBubbles](/es-ES/channels/bluebubbles) (iMessage), [iMessage](/es-ES/channels/imessage) (heredado)
- Habilidades: [Habilidades](/es-ES/tools/skills), [Configuración de Habilidades](/es-ES/tools/skills-config)
