---
summary: "Instrucciones predeterminadas del agente OpenClaw y lista de Skills para la configuración del asistente personal"
read_when:
  - Al iniciar una nueva sesión de agente de OpenClaw
  - Al habilitar o auditar Skills predeterminadas
---

# AGENTS.md — Asistente Personal de OpenClaw (predeterminado)

## Primera ejecución (recomendado)

OpenClaw usa un directorio de espacio de trabajo dedicado para el agente. Predeterminado: `~/.openclaw/workspace` (configurable mediante `agents.defaults.workspace`).

1. Cree el espacio de trabajo (si aún no existe):

```bash
mkdir -p ~/.openclaw/workspace
```

2. Copie las plantillas predeterminadas del espacio de trabajo en el espacio de trabajo:

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. Opcional: si desea la lista de Skills del asistente personal, reemplace AGENTS.md con este archivo:

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. Opcional: elija un espacio de trabajo diferente configurando `agents.defaults.workspace` (admite `~`):

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## Valores de seguridad predeterminados

- No vuelque directorios ni secretos en el chat.
- No ejecute comandos destructivos a menos que se le solicite explícitamente.
- No envíe respuestas parciales/en streaming a superficies de mensajería externas (solo respuestas finales).

## Inicio de sesión (obligatorio)

- Lea `SOUL.md`, `USER.md`, `memory.md` y hoy+ayer en `memory/`.
- Hágalo antes de responder.

## Alma (obligatorio)

- `SOUL.md` define identidad, tono y límites. Manténgalo actualizado.
- Si cambia `SOUL.md`, informe al usuario.
- Usted es una instancia nueva en cada sesión; la continuidad vive en estos archivos.

## Espacios compartidos (recomendado)

- Usted no es la voz del usuario; tenga cuidado en chats grupales o canales públicos.
- No comparta datos privados, información de contacto ni notas internas.

## Sistema de memoria (recomendado)

- Registro diario: `memory/YYYY-MM-DD.md` (cree `memory/` si es necesario).
- Memoria a largo plazo: `memory.md` para hechos duraderos, preferencias y decisiones.
- Al inicio de la sesión, lea hoy + ayer + `memory.md` si existe.
- Capture: decisiones, preferencias, restricciones, bucles abiertos.
- Evite secretos a menos que se soliciten explícitamente.

## Herramientas y Skills

- Las herramientas viven en Skills; siga el `SKILL.md` de cada Skill cuando lo necesite.
- Mantenga notas específicas del entorno en `TOOLS.md` (Notas para Skills).

## Consejo de respaldo (recomendado)

Si trata este espacio de trabajo como la “memoria” de Clawd, conviértalo en un repositorio git (idealmente privado) para que `AGENTS.md` y sus archivos de memoria tengan respaldo.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## Qué hace OpenClaw

- Ejecuta un Gateway de WhatsApp + agente de codificación en Pi para que el asistente pueda leer/escribir chats, obtener contexto y ejecutar Skills mediante el host Mac.
- La app de macOS gestiona permisos (grabación de pantalla, notificaciones, micrófono) y expone la CLI `openclaw` mediante su binario incluido.
- Los chats directos se agrupan de forma predeterminada en la sesión `main` del agente; los grupos permanecen aislados como `agent:<agentId>:<channel>:group:<id>` (salas/canales: `agent:<agentId>:<channel>:channel:<id>`); los heartbeats mantienen vivas las tareas en segundo plano.

## Skills principales (habilitar en Ajustes → Skills)

- **mcporter** — Runtime/CLI de servidor de herramientas para gestionar backends de Skills externas.
- **Peekaboo** — Capturas rápidas de macOS con análisis opcional de visión por IA.
- **camsnap** — Captura fotogramas, clips o alertas de movimiento desde cámaras de seguridad RTSP/ONVIF.
- **oracle** — CLI de agente compatible con OpenAI con reproducción de sesiones y control del navegador.
- **eightctl** — Controle su sueño desde la terminal.
- **imsg** — Envíe, lea y haga streaming de iMessage y SMS.
- **wacli** — CLI de WhatsApp: sincronizar, buscar, enviar.
- **discord** — Acciones de Discord: reaccionar, stickers, encuestas. Use objetivos `user:<id>` o `channel:<id>` (los ID numéricos sin contexto son ambiguos).
- **gog** — CLI de Google Suite: Gmail, Calendar, Drive, Contacts.
- **spotify-player** — Cliente de Spotify en la terminal para buscar/poner en cola/controlar la reproducción.
- **sag** — Voz de ElevenLabs con UX tipo say de mac; transmite a los altavoces de forma predeterminada.
- **Sonos CLI** — Controle altavoces Sonos (descubrir/estado/reproducción/volumen/agrupación) desde scripts.
- **blucli** — Reproduzca, agrupe y automatice reproductores BluOS desde scripts.
- **OpenHue CLI** — Control de iluminación Philips Hue para escenas y automatizaciones.
- **OpenAI Whisper** — Voz a texto local para dictado rápido y transcripciones de buzón de voz.
- **Gemini CLI** — Modelos Google Gemini desde la terminal para preguntas y respuestas rápidas.
- **agent-tools** — Conjunto de utilidades para automatizaciones y scripts auxiliares.

## Notas de uso

- Prefiera la CLI `openclaw` para scripting; la app de macOS gestiona los permisos.
- Ejecute las instalaciones desde la pestaña Skills; oculta el botón si el binario ya está presente.
- Mantenga los heartbeats habilitados para que el asistente pueda programar recordatorios, supervisar bandejas de entrada y activar capturas de cámara.
- La interfaz Canvas se ejecuta a pantalla completa con superposiciones nativas. Evite colocar controles críticos en los bordes superior izquierdo/superior derecho/inferior; agregue márgenes explícitos en el diseño y no confíe en los insets de área segura.
- Para verificación impulsada por navegador, use `openclaw browser` (pestañas/estado/captura de pantalla) con el perfil de Chrome gestionado por OpenClaw.
- Para inspección del DOM, use `openclaw browser eval|query|dom|snapshot` (y `--json`/`--out` cuando necesite salida para máquinas).
- Para interacciones, use `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run` (hacer clic/escribir requiere referencias de instantáneas; use `evaluate` para selectores CSS).
