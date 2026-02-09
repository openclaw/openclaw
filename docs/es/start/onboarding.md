---
summary: "Flujo de incorporación en el primer inicio para OpenClaw (app de macOS)"
read_when:
  - Diseño del asistente de incorporación de macOS
  - Implementación de autenticación o configuración de identidad
title: "Incorporación (App de macOS)"
sidebarTitle: "Onboarding: macOS App"
---

# Incorporación (App de macOS)

Este documento describe el flujo de incorporación **actual** en el primer inicio. El objetivo es una experiencia fluida desde el “día 0”: elegir dónde se ejecuta el Gateway, conectar la autenticación, ejecutar el asistente y permitir que el agente se inicialice por sí mismo.

<Steps>
<Step title="Approve macOS warning">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Approve find local networks">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Welcome and security notice">
<Frame caption="Lea el aviso de seguridad mostrado y decida en consecuencia">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remote">
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
<Step title="Permissions">
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
<Step title="Onboarding Chat (dedicated session)">
  Después de la configuración, la app abre una sesión de chat de incorporación dedicada para que el agente pueda
  presentarse y guiar los siguientes pasos. Esto mantiene la guía del primer inicio separada
  de su conversación normal. Consulte [Bootstrapping](/start/bootstrapping) para
  saber qué sucede en el host del Gateway durante la primera ejecución del agente.
</Step>
</Steps>
