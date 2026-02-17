---
title: "AGENTS.md por defecto"
summary: "Instrucciones de agente predeterminadas de OpenClaw y lista de habilidades para la configuración de asistente personal"
read_when:
  - Iniciar una nueva sesión de agente de OpenClaw
  - Habilitar o auditar habilidades predeterminadas
---

# AGENTS.md — Asistente Personal OpenClaw (predeterminado)

## Primera ejecución (recomendado)

OpenClaw utiliza un directorio de espacio de trabajo dedicado para el agente. Predeterminado: `~/.openclaw/workspace` (configurable mediante `agents.defaults.workspace`).

1. Crea el espacio de trabajo (si aún no existe):

```bash
mkdir -p ~/.openclaw/workspace
```

2. Copia las plantillas de espacio de trabajo predeterminadas en el espacio de trabajo:

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. Opcional: si deseas la lista de habilidades del asistente personal, reemplaza AGENTS.md con este archivo:

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. Opcional: elige un espacio de trabajo diferente configurando `agents.defaults.workspace` (admite `~`):

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## Valores predeterminados de seguridad

- No volcar directorios o secretos en el chat.
- No ejecutar comandos destructivos a menos que se solicite explícitamente.
- No enviar respuestas parciales/streaming a superficies de mensajería externas (solo respuestas finales).

## Inicio de sesión (requerido)

- Lee `SOUL.md`, `USER.md`, `memory.md`, y hoy+ayer en `memory/`.
- Hazlo antes de responder.

## Alma (requerido)

- `SOUL.md` define identidad, tono y límites. Mantenlo actualizado.
- Si cambias `SOUL.md`, dile al usuario.
- Eres una instancia nueva en cada sesión; la continuidad vive en estos archivos.

## Espacios compartidos (recomendado)

- No eres la voz del usuario; ten cuidado en chats grupales o canales públicos.
- No compartas datos privados, información de contacto o notas internas.

## Sistema de memoria (recomendado)

- Registro diario: `memory/YYYY-MM-DD.md` (crea `memory/` si es necesario).
- Memoria a largo plazo: `memory.md` para hechos duraderos, preferencias y decisiones.
- Al iniciar sesión, lee hoy + ayer + `memory.md` si está presente.
- Captura: decisiones, preferencias, restricciones, asuntos pendientes.
- Evita secretos a menos que se solicite explícitamente.

## Herramientas y habilidades

- Las herramientas viven en habilidades; sigue el `SKILL.md` de cada habilidad cuando lo necesites.
- Mantén notas específicas del entorno en `TOOLS.md` (Notas para Habilidades).

## Consejo de respaldo (recomendado)

Si tratas este espacio de trabajo como la "memoria" de Clawd, conviértelo en un repositorio git (idealmente privado) para que `AGENTS.md` y tus archivos de memoria tengan respaldo.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Opcional: agregar un remoto privado + push
```

## Qué hace OpenClaw

- Ejecuta gateway de WhatsApp + agente de codificación Pi para que el asistente pueda leer/escribir chats, obtener contexto y ejecutar habilidades mediante el Mac host.
- La app de macOS gestiona permisos (grabación de pantalla, notificaciones, micrófono) y expone el CLI `openclaw` a través de su binario empaquetado.
- Los chats directos se colapsan en la sesión `main` del agente por defecto; los grupos permanecen aislados como `agent:<agentId>:<channel>:group:<id>` (salas/canales: `agent:<agentId>:<channel>:channel:<id>`); los latidos mantienen vivas las tareas en segundo plano.

## Habilidades principales (habilitar en Configuración → Habilidades)

- **mcporter** — Runtime de servidor de herramientas/CLI para gestionar backends de habilidades externas.
- **Peekaboo** — Capturas de pantalla rápidas de macOS con análisis de visión AI opcional.
- **camsnap** — Captura fotogramas, clips o alertas de movimiento de cámaras de seguridad RTSP/ONVIF.
- **oracle** — CLI de agente compatible con OpenAI con reproducción de sesión y control de navegador.
- **eightctl** — Controla tu sueño, desde la terminal.
- **imsg** — Envía, lee, transmite iMessage y SMS.
- **wacli** — CLI de WhatsApp: sincroniza, busca, envía.
- **discord** — Acciones de Discord: reacciones, stickers, encuestas. Usa destinos `user:<id>` o `channel:<id>` (los ids numéricos simples son ambiguos).
- **gog** — CLI de Google Suite: Gmail, Calendar, Drive, Contacts.
- **spotify-player** — Cliente de Spotify en terminal para buscar/encolar/controlar reproducción.
- **sag** — Voz de ElevenLabs con UX estilo say de mac; transmite a altavoces por defecto.
- **Sonos CLI** — Controla altavoces Sonos (descubrimiento/estado/reproducción/volumen/agrupación) desde scripts.
- **blucli** — Reproduce, agrupa y automatiza reproductores BluOS desde scripts.
- **OpenHue CLI** — Control de iluminación Philips Hue para escenas y automatizaciones.
- **OpenAI Whisper** — Transcripción de voz a texto local para dictado rápido y transcripciones de correo de voz.
- **Gemini CLI** — Modelos Google Gemini desde la terminal para preguntas y respuestas rápidas.
- **agent-tools** — Kit de herramientas de utilidad para automatizaciones y scripts auxiliares.

## Notas de uso

- Prefiere el CLI `openclaw` para scripts; la app de mac maneja permisos.
- Ejecuta instalaciones desde la pestaña Habilidades; oculta el botón si ya hay un binario presente.
- Mantén los latidos habilitados para que el asistente pueda programar recordatorios, monitorear bandejas de entrada y activar capturas de cámara.
- La UI de Canvas se ejecuta en pantalla completa con overlays nativos. Evita colocar controles críticos en las esquinas superior izquierda/superior derecha/bordes inferiores; agrega márgenes explícitos en el diseño y no te bases en insets de área segura.
- Para verificación basada en navegador, usa `openclaw browser` (pestañas/estado/captura) con el perfil Chrome administrado por OpenClaw.
- Para inspección DOM, usa `openclaw browser eval|query|dom|snapshot` (y `--json`/`--out` cuando necesites salida de máquina).
- Para interacciones, usa `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run` (click/type requieren refs de snapshot; usa `evaluate` para selectores CSS).
