---
summary: "Flujo de incorporación en el primer inicio para OpenClaw (app de macOS)"
read_when:
  - Diseño del asistente de incorporación de macOS
  - Implementación de autenticación o configuración de identidad
title: "Incorporación (App de macOS)"
sidebarTitle: "Onboarding: macOS App"
x-i18n:
  source_path: start/onboarding.md
  source_hash: 45f912067527158f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:34:37Z
---

# Incorporación (App de macOS)

Este documento describe el flujo de incorporación **actual** en el primer inicio. El objetivo es una experiencia fluida desde el “día 0”: elegir dónde se ejecuta el Gateway, conectar la autenticación, ejecutar el asistente y permitir que el agente se inicialice por sí mismo.

<Steps>
<Step title="Aprobar advertencia de macOS">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Aprobar búsqueda de redes locales">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Bienvenida y aviso de seguridad">
<Frame caption="Lea el aviso de seguridad mostrado y decida en consecuencia">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remoto">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

¿Dónde se ejecuta el **Gateway**?

- **Este Mac (solo local):** la incorporación puede ejecutar flujos OAuth y escribir credenciales localmente.
- **Remoto (por SSH/Tailnet):** la incorporación **no** ejecuta OAuth localmente; las credenciales deben existir en el host del Gateway.
- **Configurar más tarde:** omitir la configuración y dejar la app sin configurar.

<Tip>
**Consejo de autenticación del Gateway:**
- El asistente ahora genera un **token** incluso para loopback, por lo que los clientes WS locales deben autenticarse.
- Si deshabilita la autenticación, cualquier proceso local puede conectarse; úselo solo en máquinas totalmente confiables.
- Use un **token** para acceso desde varias máquinas o enlaces que no sean loopback.
</Tip>
</Step>
<Step title="Permisos">
<Frame caption="Elija qué permisos desea otorgar a OpenClaw">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

La incorporación solicita permisos TCC necesarios para:

- Automatización (AppleScript)
- Notificaciones
- Accesibilidad
- Grabación de pantalla
- Micrófono
- Reconocimiento de voz
- Cámara
- Ubicación

</Step>
<Step title="CLI">
  <Info>Este paso es opcional</Info>
  La app puede instalar la CLI global `openclaw` mediante npm/pnpm para que
  los flujos de trabajo en terminal y las tareas de launchd funcionen de inmediato.
</Step>
<Step title="Chat de incorporación (sesión dedicada)">
  Después de la configuración, la app abre una sesión de chat de incorporación dedicada para que el agente pueda
  presentarse y guiar los siguientes pasos. Esto mantiene la guía del primer inicio separada
  de su conversación normal. Consulte [Bootstrapping](/start/bootstrapping) para
  saber qué sucede en el host del Gateway durante la primera ejecución del agente.
</Step>
</Steps>
