---
summary: "Referencia completa del asistente de incorporación de la CLI: cada paso, bandera y campo de configuración"
read_when:
  - Consultar un paso o una bandera específica del asistente
  - Automatizar la incorporación con el modo no interactivo
  - Depurar el comportamiento del asistente
title: "Referencia del asistente de incorporación"
sidebarTitle: "Wizard Reference"
---

# Referencia del asistente de incorporación

Esta es la referencia completa del asistente de la CLI `openclaw onboard`.
Para una visión general de alto nivel, consulte [Asistente de incorporación](/start/wizard).

## Detalles del flujo (modo local)

<Steps>
  <Step title="Existing config detection">
    - Si existe `~/.openclaw/openclaw.json`, elija **Conservar / Modificar / Restablecer**.
    - Volver a ejecutar el asistente **no** borra nada a menos que usted elija explícitamente **Restablecer**
      (o pase `--reset`).
    - Si la configuración es inválida o contiene claves heredadas, el asistente se detiene y le pide
      que ejecute `openclaw doctor` antes de continuar.
    - El restablecimiento usa `trash` (nunca `rm`) y ofrece alcances:
      - Solo configuración
      - Configuración + credenciales + sesiones
      - Restablecimiento completo (también elimina el espacio de trabajo)  
</Step>
  <Step title="Model/Auth">
    - **Clave de API de Anthropic (recomendada)**: usa `ANTHROPIC_API_KEY` si está presente o solicita una clave, luego la guarda para uso del daemon.
    - **OAuth de Anthropic (Claude Code CLI)**: en macOS el asistente revisa el elemento del Llavero "Claude Code-credentials" (elija "Permitir siempre" para que los inicios de launchd no se bloqueen); en Linux/Windows reutiliza `~/.claude/.credentials.json` si está presente.
    - **Token de Anthropic (pegar setup-token)**: ejecute `claude setup-token` en cualquier máquina y luego pegue el token (puede nombrarlo; en blanco = predeterminado).
    - **Suscripción a OpenAI Code (Codex) (Codex CLI)**: si existe `~/.codex/auth.json`, el asistente puede reutilizarla.
    - **Suscripción a OpenAI Code (Codex) (OAuth)**: flujo en el navegador; pegue `code#state`.
      - Establece `agents.defaults.model` en `openai-codex/gpt-5.2` cuando el modelo no está configurado o es `openai/*`.
    - **Clave de API de OpenAI**: usa `OPENAI_API_KEY` si está presente o solicita una clave, luego la guarda en `~/.openclaw/.env` para que launchd pueda leerla.
    - **Clave de API de xAI (Grok)**: solicita `XAI_API_KEY` y configura xAI como proveedor de modelos.
    - **OpenCode Zen (proxy multimodelo)**: solicita `OPENCODE_API_KEY` (o `OPENCODE_ZEN_API_KEY`, obténgalo en https://opencode.ai/auth).
    - **Clave de API**: almacena la clave por usted.
    - **Vercel AI Gateway (proxy multimodelo)**: solicita `AI_GATEWAY_API_KEY`.
    - Más detalles: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: solicita ID de cuenta, ID del Gateway y `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - Más detalles: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: la configuración se escribe automáticamente.
    - Más detalles: [MiniMax](/providers/minimax)
    - **Synthetic (compatible con Anthropic)**: solicita `SYNTHETIC_API_KEY`.
    - Más detalles: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: la configuración se escribe automáticamente.
    - **Kimi Coding**: la configuración se escribe automáticamente.
    - Más detalles: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Omitir**: aún no se configura autenticación.
    - Elija un modelo predeterminado entre las opciones detectadas (o ingrese proveedor/modelo manualmente).
    - El asistente ejecuta una verificación del modelo y advierte si el modelo configurado es desconocido o falta autenticación.
    - Las credenciales OAuth viven en `~/.openclaw/credentials/oauth.json`; los perfiles de autenticación viven en `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (claves de API + OAuth).
    - Más detalles: [/concepts/oauth](/concepts/oauth)    
<Note>
    Consejo para entornos sin interfaz gráfica/servidores: complete OAuth en una máquina con navegador y luego copie
    `~/.openclaw/credentials/oauth.json` (o `$OPENCLAW_STATE_DIR/credentials/oauth.json`) al
    host del Gateway.
    </Note>
  </Step>
  <Step title="Workspace">
    - `~/.openclaw/workspace` predeterminado (configurable).
    - Inicializa los archivos del espacio de trabajo necesarios para el ritual de arranque del agente.
    - Diseño completo del espacio de trabajo + guía de respaldo: [Espacio de trabajo del agente](/concepts/agent-workspace)  
</Step>
  <Step title="Gateway">
    - Puerto, enlace, modo de autenticación, exposición por Tailscale.
    - Recomendación de autenticación: mantenga **Token** incluso para loopback, de modo que los clientes WS locales deban autenticarse.
    - Desactive la autenticación solo si confía plenamente en cada proceso local.
    - Los enlaces que no son loopback aún requieren autenticación.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): inicio de sesión por QR opcional.
    - [Telegram](/channels/telegram): token del bot.
    - [Discord](/channels/discord): token del bot.
    - [Google Chat](/channels/googlechat): JSON de cuenta de servicio + audiencia del webhook.
    - [Mattermost](/channels/mattermost) (plugin): token del bot + URL base.
    - [Signal](/channels/signal): instalación opcional de `signal-cli` + configuración de la cuenta.
    - [BlueBubbles](/channels/bluebubbles): **recomendado para iMessage**; URL del servidor + contraseña + webhook.
    - [iMessage](/channels/imessage): ruta heredada de la CLI `imsg` + acceso a la base de datos.
    - Seguridad de mensajes directos: el valor predeterminado es el emparejamiento. El primer mensaje directo envía un código; apruébelo mediante `openclaw pairing approve <channel><code>` o use listas de permitidos.
  </Step><code>` o use listas de permitidos.
  </Step>
  <Step title="Instalación del daemon">
    - macOS: LaunchAgent
      - Requiere una sesión de usuario iniciada; para entornos sin interfaz, use un LaunchDaemon personalizado (no incluido).
    - Linux (y Windows vía WSL2): unidad de usuario systemd
      - El asistente intenta habilitar el modo persistente mediante `loginctl enable-linger <user>` para que el Gateway permanezca activo después de cerrar sesión.
      - Puede solicitar sudo (escribe `/var/lib/systemd/linger`); primero lo intenta sin sudo.
    - **Selección de runtime:** Node (recomendado; requerido para WhatsApp/Telegram). Bun **no** es recomendado.
  </Step>
  <Step title="Comprobación de estado">
    - Inicia el Gateway (si es necesario) y ejecuta `openclaw health`.
    - Consejo: `openclaw status --deep` agrega sondeos de estado del gateway a la salida de estado (requiere un gateway accesible).
  </Step>
  <Step title="Skills (recomendado)">
    - Lee las Skills disponibles y verifica los requisitos.
    - Le permite elegir un gestor de Node: **npm / pnpm** (bun no recomendado).
    - Instala dependencias opcionales (algunas usan Homebrew en macOS).
  </Step>
  <Step title="Finalizar">
    - Resumen y siguientes pasos, incluidas aplicaciones para iOS/Android/macOS para funciones adicionales.
  </Step>
</Steps>

<Note>
Si no se detecta una GUI, el asistente imprime instrucciones de reenvío de puertos SSH para la Interfaz de Control en lugar de abrir un navegador.
Si faltan los recursos de la Interfaz de Control, el asistente intenta compilarlos; la alternativa es `pnpm ui:build` (instala automáticamente las dependencias de la UI).
</Note>

## Modo no interactivo

Use `--non-interactive` para automatizar o crear scripts de la incorporación:

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

Agregue `--json` para un resumen legible por máquinas.

<Note>
`--json` **no** implica modo no interactivo. Use `--non-interactive` (y `--workspace`) para scripts.
</Note>

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
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
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
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

El Gateway expone el flujo del asistente por RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Los clientes (app de macOS, Interfaz de Control) pueden renderizar los pasos sin reimplementar la lógica de incorporación.

## Configuración de Signal (signal-cli)

El asistente puede instalar `signal-cli` desde las versiones de GitHub:

- Descarga el asset de la versión apropiada.
- Lo almacena en `~/.openclaw/tools/signal-cli/<version>/`.
- Escribe `channels.signal.cliPath` en su configuración.

Notas:

- Las compilaciones JVM requieren **Java 21**.
- Las compilaciones nativas se usan cuando están disponibles.
- Windows usa WSL2; la instalación de signal-cli sigue el flujo de Linux dentro de WSL.

## Qué escribe el asistente

Campos típicos en `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (si se elige Minimax)
- `gateway.*` (modo, enlace, autenticación, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Listas de permitidos de canales (Slack/Discord/Matrix/Microsoft Teams) cuando usted opta por ellas durante los avisos (los nombres se resuelven a IDs cuando es posible).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` escribe `agents.list[]` y el opcional `bindings`.

Las credenciales de WhatsApp se guardan en `~/.openclaw/credentials/whatsapp/<accountId>/`.
Las sesiones se almacenan en `~/.openclaw/agents/<agentId>/sessions/`.

Algunos canales se entregan como plugins. Cuando usted selecciona uno durante la incorporación, el asistente
le pedirá instalarlo (npm o una ruta local) antes de poder configurarlo.

## Documentos relacionados

- Descripción general del asistente: [Asistente de incorporación](/start/wizard)
- Incorporación de la app de macOS: [Incorporación](/start/onboarding)
- Referencia de configuración: [Configuración del Gateway](/gateway/configuration)
- Proveedores: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (heredado)
- Skills: [Skills](/tools/skills), [Configuración de Skills](/tools/skills-config)
