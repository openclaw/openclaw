---
summary: "Asistente de incorporación CLI: configuración guiada para gateway, espacio de trabajo, canales y habilidades"
read_when:
  - Ejecutando o configurando el asistente de incorporación
  - Configurando una nueva máquina
title: "Asistente de Incorporación (CLI)"
sidebarTitle: "Incorporación: CLI"
---

# Asistente de Incorporación (CLI)

El asistente de incorporación es la forma **recomendada** de configurar OpenClaw en macOS,
Linux o Windows (vía WSL2; altamente recomendado).
Configura un Gateway local o una conexión a un Gateway remoto, además de canales, habilidades
y valores predeterminados del espacio de trabajo en un flujo guiado.

```bash
openclaw onboard
```

<Info>
Primer chat más rápido: abre la Interfaz de Control (no se necesita configuración de canal). Ejecuta
`openclaw dashboard` y chatea en el navegador. Documentación: [Panel de Control](/web/dashboard).
</Info>

Para reconfigurar más tarde:

```bash
openclaw configure
openclaw agents add <nombre>
```

<Note>
`--json` no implica modo no interactivo. Para scripts, usa `--non-interactive`.
</Note>

<Tip>
Recomendado: configura una clave API de Brave Search para que el agente pueda usar `web_search`
(`web_fetch` funciona sin clave). Ruta más fácil: `openclaw configure --section web`
que almacena `tools.web.search.apiKey`. Documentación: [Herramientas web](/tools/web).
</Tip>

## Inicio Rápido vs Avanzado

El asistente comienza con **Inicio Rápido** (valores predeterminados) vs **Avanzado** (control completo).

<Tabs>
  <Tab title="Inicio Rápido (predeterminados)">
    - Gateway local (loopback)
    - Espacio de trabajo predeterminado (o espacio de trabajo existente)
    - Puerto del gateway **18789**
    - Autenticación del gateway **Token** (auto-generado, incluso en loopback)
    - Exposición Tailscale **Desactivada**
    - Los mensajes directos de Telegram + WhatsApp usan **lista de permitidos** por defecto (se te pedirá tu número de teléfono)
  </Tab>
  <Tab title="Avanzado (control completo)">
    - Expone cada paso (modo, espacio de trabajo, gateway, canales, daemon, habilidades).
  </Tab>
</Tabs>

## Lo que configura el asistente

**Modo local (predeterminado)** te guía a través de estos pasos:

1. **Modelo/Autenticación** — Clave API de Anthropic (recomendado), OpenAI o Proveedor Personalizado
   (compatible con OpenAI, compatible con Anthropic o auto-detección Desconocido). Elige un modelo predeterminado.
2. **Espacio de trabajo** — Ubicación para archivos del agente (predeterminado `~/.openclaw/workspace`). Inicializa archivos de arranque.
3. **Gateway** — Puerto, dirección de enlace, modo de autenticación, exposición Tailscale.
4. **Canales** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles o iMessage.
5. **Daemon** — Instala un LaunchAgent (macOS) o unidad de usuario systemd (Linux/WSL2).
6. **Verificación de salud** — Inicia el Gateway y verifica que esté ejecutándose.
7. **Habilidades** — Instala habilidades recomendadas y dependencias opcionales.

<Note>
Volver a ejecutar el asistente **no** borra nada a menos que explícitamente elijas **Restablecer** (o pases `--reset`).
Si la configuración es inválida o contiene claves heredadas, el asistente te pide ejecutar `openclaw doctor` primero.
</Note>

**Modo remoto** solo configura el cliente local para conectarse a un Gateway en otro lugar.
**No** instala ni cambia nada en el host del gateway remoto.

## Agregar otro agente

Usa `openclaw agents add <nombre>` para crear un agente separado con su propio espacio de trabajo,
sesiones y perfiles de autenticación. Ejecutar sin `--workspace` lanza el asistente.

Lo que establece:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Notas:

- Los espacios de trabajo predeterminados siguen `~/.openclaw/workspace-<agentId>`.
- Agrega `bindings` para enrutar mensajes entrantes (el asistente puede hacer esto).
- Indicadores no interactivos: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Referencia completa

Para desgloses detallados paso a paso, scripting no interactivo, configuración de Signal,
API RPC y una lista completa de campos de configuración que escribe el asistente, consulta la
[Referencia del Asistente](/reference/wizard).

## Documentación relacionada

- Referencia de comandos CLI: [`openclaw onboard`](/cli/onboard)
- Resumen de incorporación: [Resumen de Incorporación](/start/onboarding-overview)
- Incorporación de la app macOS: [Incorporación](/start/onboarding)
- Ritual de primera ejecución del agente: [Inicialización del Agente](/start/bootstrapping)
