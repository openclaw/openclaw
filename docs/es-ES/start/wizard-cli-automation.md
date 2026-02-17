---
summary: "Onboarding y configuración de agente mediante scripts para OpenClaw CLI"
read_when:
  - Estás automatizando onboarding en scripts o CI
  - Necesitas ejemplos no interactivos para proveedores específicos
title: "Automatización CLI"
sidebarTitle: "Automatización CLI"
---

# Automatización CLI

Usa `--non-interactive` para automatizar `openclaw onboard`.

<Note>
`--json` no implica modo no interactivo. Usa `--non-interactive` (y `--workspace`) para scripts.
</Note>

## Ejemplo base no interactivo

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

## Ejemplos específicos de proveedores

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
      --cloudflare-ai-gateway-account-id "tu-id-de-cuenta" \
      --cloudflare-ai-gateway-gateway-id "tu-id-de-gateway" \
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
  <Accordion title="Ejemplo de proveedor personalizado">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice custom-api-key \
      --custom-base-url "https://llm.example.com/v1" \
      --custom-model-id "foo-large" \
      --custom-api-key "$CUSTOM_API_KEY" \
      --custom-provider-id "mi-personalizado" \
      --custom-compatibility anthropic \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```

    `--custom-api-key` es opcional. Si se omite, el onboarding verifica `CUSTOM_API_KEY`.

  </Accordion>
</AccordionGroup>

## Agregar otro agente

Usa `openclaw agents add <nombre>` para crear un agente separado con su propio workspace,
sesiones y perfiles de autenticación. Ejecutar sin `--workspace` lanza el asistente.

```bash
openclaw agents add trabajo \
  --workspace ~/.openclaw/workspace-trabajo \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

Lo que establece:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Notas:

- Los workspaces predeterminados siguen `~/.openclaw/workspace-<agentId>`.
- Agrega `bindings` para enrutar mensajes entrantes (el asistente puede hacer esto).
- Flags no interactivos: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Documentación relacionada

- Hub de onboarding: [Asistente de Onboarding (CLI)](/es-ES/start/wizard)
- Referencia completa: [Referencia CLI de Onboarding](/es-ES/start/wizard-cli-reference)
- Referencia de comando: [`openclaw onboard`](/es-ES/cli/onboard)
