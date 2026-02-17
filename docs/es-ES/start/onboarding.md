---
summary: "Flujo de incorporación de primera ejecución para OpenClaw (app macOS)"
read_when:
  - Diseñando el asistente de incorporación de macOS
  - Implementando autenticación o configuración de identidad
title: "Incorporación (App macOS)"
sidebarTitle: "Incorporación: App macOS"
---

# Incorporación (App macOS)

Esta documentación describe el flujo de incorporación de primera ejecución **actual**. El objetivo es una
experiencia suave del "día 0": elegir dónde ejecutar el Gateway, conectar autenticación, ejecutar el
asistente y dejar que el agente se inicialice.
Para una visión general de las rutas de incorporación, consulta [Resumen de Incorporación](/start/onboarding-overview).

<Steps>
<Step title="Aprobar advertencia de macOS">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Aprobar buscar redes locales">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Bienvenida y aviso de seguridad">
<Frame caption="Lee el aviso de seguridad mostrado y decide en consecuencia">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remoto">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

¿Dónde ejecuta el **Gateway**?

- **Esta Mac (Solo local):** la incorporación puede ejecutar flujos OAuth y escribir credenciales
  localmente.
- **Remoto (por SSH/Tailnet):** la incorporación **no** ejecuta OAuth localmente;
  las credenciales deben existir en el host del gateway.
- **Configurar más tarde:** omitir configuración y dejar la app sin configurar.

<Tip>
**Consejo de autenticación del Gateway:**
- El asistente ahora genera un **token** incluso para loopback, por lo que los clientes WS locales deben autenticarse.
- Si deshabilitas la autenticación, cualquier proceso local puede conectarse; usa esto solo en máquinas completamente confiables.
- Usa un **token** para acceso multi-máquina o enlaces no-loopback.
</Tip>
</Step>
<Step title="Permisos">
<Frame caption="Elige qué permisos quieres dar a OpenClaw">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

La incorporación solicita permisos TCC necesarios para:

- Automatización (AppleScript)
- Notificaciones
- Accesibilidad
- Grabación de Pantalla
- Micrófono
- Reconocimiento de Voz
- Cámara
- Ubicación

</Step>
<Step title="CLI">
  <Info>Este paso es opcional</Info>
  La app puede instalar el CLI global `openclaw` vía npm/pnpm para que los
  flujos de trabajo de terminal y las tareas de launchd funcionen desde el principio.
</Step>
<Step title="Chat de Incorporación (sesión dedicada)">
  Después de la configuración, la app abre una sesión de chat de incorporación dedicada para que el agente pueda
  presentarse y guiar los siguientes pasos. Esto mantiene la guía de primera ejecución separada
  de tu conversación normal. Consulta [Inicialización](/start/bootstrapping) para
  qué sucede en el host del gateway durante la primera ejecución del agente.
</Step>
</Steps>
