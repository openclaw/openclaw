---
summary: "Preguntas frecuentes sobre la configuración, instalación y uso de OpenClaw"
title: "Preguntas frecuentes"
---

# Preguntas frecuentes

Respuestas rápidas más solución de problemas en profundidad para configuraciones del mundo real (desarrollo local, VPS, multi‑agente, OAuth/claves de API, conmutación por error de modelos). Para diagnósticos en tiempo de ejecución, consulte [Solución de problemas](/gateway/troubleshooting). Para la referencia completa de configuración, consulte [Configuración](/gateway/configuration).

## Tabla de contenidos

- [Inicio rápido y configuración inicial]
  - [Estoy atascado, ¿cuál es la forma más rápida de salir del atasco?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [¿Cuál es la forma recomendada de instalar y configurar OpenClaw?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [¿Cómo abro el panel después del onboarding?](#how-do-i-open-the-dashboard-after-onboarding)
  - [¿Cómo autentico el panel (token) en localhost vs remoto?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [¿Qué runtime necesito?](#what-runtime-do-i-need)
  - [¿Funciona en Raspberry Pi?](#does-it-run-on-raspberry-pi)
  - [¿Algún consejo para instalaciones en Raspberry Pi?](#any-tips-for-raspberry-pi-installs)
  - [Está atascado en "wake up my friend" / el onboarding no arranca. ¿Y ahora qué?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [¿Puedo migrar mi configuración a una máquina nueva (Mac mini) sin rehacer el onboarding?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [¿Dónde veo qué hay de nuevo en la última versión?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [No puedo acceder a docs.openclaw.ai (error SSL). ¿Qué hago?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [¿Cuál es la diferencia entre estable y beta?](#whats-the-difference-between-stable-and-beta)
  - [¿Cómo instalo la versión beta y cuál es la diferencia entre beta y dev?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [¿Cómo pruebo lo más reciente?](#how-do-i-try-the-latest-bits)
  - [¿Cuánto suelen tardar la instalación y el onboarding?](#how-long-does-install-and-onboarding-usually-take)
  - [¿El instalador está atascado? ¿Cómo obtengo más información?](#installer-stuck-how-do-i-get-more-feedback)
  - [La instalación en Windows dice git no encontrado o openclaw no reconocido](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [La documentación no respondió mi pregunta: ¿cómo obtengo una mejor respuesta?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [¿Cómo instalo OpenClaw en Linux?](#how-do-i-install-openclaw-on-linux)
  - [¿Cómo instalo OpenClaw en un VPS?](#how-do-i-install-openclaw-on-a-vps)
  - [¿Dónde están las guías de instalación en la nube/VPS?](#where-are-the-cloudvps-install-guides)
  - [¿Puedo pedirle a OpenClaw que se actualice solo?](#can-i-ask-openclaw-to-update-itself)
  - [¿Qué hace realmente el asistente de onboarding?](#what-does-the-onboarding-wizard-actually-do)
  - [¿Necesito una suscripción a Claude u OpenAI para ejecutar esto?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [¿Puedo usar la suscripción Claude Max sin una clave de API?](#can-i-use-claude-max-subscription-without-an-api-key)
  - [¿Cómo funciona la autenticación "setup-token" de Anthropic?](#how-does-anthropic-setuptoken-auth-work)
  - [¿Dónde encuentro un setup-token de Anthropic?](#where-do-i-find-an-anthropic-setuptoken)
  - [¿Admiten autenticación por suscripción de Claude (Claude Pro o Max)?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [¿Por qué veo `HTTP 429: rate_limit_error` de Anthropic?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [¿Se admite AWS Bedrock?](#is-aws-bedrock-supported)
  - [¿Cómo funciona la autenticación de Codex?](#how-does-codex-auth-work)
  - [¿Admiten autenticación por suscripción de OpenAI (Codex OAuth)?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [¿Cómo configuro Gemini CLI OAuth?](#how-do-i-set-up-gemini-cli-oauth)
  - [¿Un modelo local sirve para chats casuales?](#is-a-local-model-ok-for-casual-chats)
  - [¿Cómo mantengo el tráfico de modelos alojados en una región específica?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [¿Tengo que comprar un Mac mini para instalar esto?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [¿Necesito un Mac mini para compatibilidad con iMessage?](#do-i-need-a-mac-mini-for-imessage-support)
  - [Si compro un Mac mini para ejecutar OpenClaw, ¿puedo conectarlo a mi MacBook Pro?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [¿Puedo usar Bun?](#can-i-use-bun)
  - [Telegram: ¿qué va en `allowFrom`?](#telegram-what-goes-in-allowfrom)
  - [¿Varias personas pueden usar un número de WhatsApp con distintas instancias de OpenClaw?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [¿Puedo ejecutar un agente de “chat rápido” y otro “Opus para programación”?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [¿Homebrew funciona en Linux?](#does-homebrew-work-on-linux)
  - [¿Cuál es la diferencia entre la instalación hackable (git) y npm?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [¿Puedo cambiar entre instalaciones npm y git más adelante?](#can-i-switch-between-npm-and-git-installs-later)
  - [¿Debería ejecutar el Gateway en mi laptop o en un VPS?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [¿Qué tan importante es ejecutar OpenClaw en una máquina dedicada?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [¿Cuáles son los requisitos mínimos de un VPS y el SO recomendado?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [¿Puedo ejecutar OpenClaw en una VM y cuáles son los requisitos?](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [¿Qué es OpenClaw?](#what-is-openclaw)
  - [¿Qué es OpenClaw en un párrafo?](#what-is-openclaw-in-one-paragraph)
  - [¿Cuál es la propuesta de valor?](#whats-the-value-proposition)
  - [Acabo de configurarlo, ¿qué debería hacer primero?](#i-just-set-it-up-what-should-i-do-first)
  - [¿Cuáles son los cinco casos de uso cotidianos principales de OpenClaw?](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [¿Puede OpenClaw ayudar con generación de leads, outreach, anuncios y blogs para un SaaS?](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [¿Cuáles son las ventajas frente a Claude Code para desarrollo web?](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills y automatización](#skills-and-automation)
  - [¿Cómo personalizo skills sin ensuciar el repo?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [¿Puedo cargar skills desde una carpeta personalizada?](#can-i-load-skills-from-a-custom-folder)
  - [¿Cómo puedo usar diferentes modelos para distintas tareas?](#how-can-i-use-different-models-for-different-tasks)
  - [El bot se congela al hacer trabajo pesado. ¿Cómo lo descargo?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron o recordatorios no se ejecutan. ¿Qué debo revisar?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [¿Cómo instalo skills en Linux?](#how-do-i-install-skills-on-linux)
  - [¿Puede OpenClaw ejecutar tareas programadas o continuamente en segundo plano?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [¿Puedo ejecutar skills solo de macOS desde Linux?](#can-i-run-apple-macos-only-skills-from-linux)
  - [¿Tienen integración con Notion o HeyGen?](#do-you-have-a-notion-or-heygen-integration)
  - [¿Cómo instalo la extensión de Chrome para control del navegador?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Sandboxing y memoria](#sandboxing-and-memory)
  - [¿Hay un documento dedicado a sandboxing?](#is-there-a-dedicated-sandboxing-doc)
  - [¿Cómo vinculo una carpeta del host al sandbox?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [¿Cómo funciona la memoria?](#how-does-memory-work)
  - [La memoria olvida cosas. ¿Cómo hago que se guarden?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [¿La memoria persiste para siempre? ¿Cuáles son los límites?](#does-memory-persist-forever-what-are-the-limits)
  - [¿La búsqueda semántica de memoria requiere una clave de API de OpenAI?](#does-semantic-memory-search-require-an-openai-api-key)
- [Dónde viven las cosas en disco](#where-things-live-on-disk)
  - [¿Todos los datos usados con OpenClaw se guardan localmente?](#is-all-data-used-with-openclaw-saved-locally)
  - [¿Dónde almacena OpenClaw sus datos?](#where-does-openclaw-store-its-data)
  - [¿Dónde deben vivir AGENTS.md / SOUL.md / USER.md / MEMORY.md?](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [¿Cuál es la estrategia de respaldo recomendada?](#whats-the-recommended-backup-strategy)
  - [¿Cómo desinstalo OpenClaw por completo?](#how-do-i-completely-uninstall-openclaw)
  - [¿Pueden los agentes trabajar fuera del espacio de trabajo?](#can-agents-work-outside-the-workspace)
  - [Estoy en modo remoto: ¿dónde está el almacén de sesiones?](#im-in-remote-mode-where-is-the-session-store)
- [Conceptos básicos de configuración](#config-basics)
  - [¿Qué formato tiene la configuración? ¿Dónde está?](#what-format-is-the-config-where-is-it)
  - [Configuré `gateway.bind: "lan"` (o `"tailnet"`) y ahora nada escucha / la UI dice no autorizado](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [¿Por qué ahora necesito un token en localhost?](#why-do-i-need-a-token-on-localhost-now)
  - [¿Tengo que reiniciar después de cambiar la configuración?](#do-i-have-to-restart-after-changing-config)
  - [¿Cómo habilito la búsqueda web (y web fetch)?](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply borró mi configuración. ¿Cómo recupero y evito esto?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [¿Cómo ejecuto un Gateway central con workers especializados en varios dispositivos?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [¿El navegador de OpenClaw puede ejecutarse en modo headless?](#can-the-openclaw-browser-run-headless)
  - [¿Cómo uso Brave para control del navegador?](#how-do-i-use-brave-for-browser-control)
- [Gateways y nodos remotos](#remote-gateways-and-nodes)
  - [¿Cómo se propagan los comandos entre Telegram, el gateway y los nodos?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [¿Cómo puede mi agente acceder a mi computadora si el Gateway está alojado remotamente?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale está conectado pero no recibo respuestas. ¿Qué hago?](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [¿Pueden hablar entre sí dos instancias de OpenClaw (local + VPS)?](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [¿Necesito VPS separados para múltiples agentes?](#do-i-need-separate-vpses-for-multiple-agents)
  - [¿Hay un beneficio en usar un nodo en mi laptop personal en lugar de SSH desde un VPS?](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [¿Los nodos ejecutan un servicio de gateway?](#do-nodes-run-a-gateway-service)
  - [¿Existe una forma API / RPC de aplicar configuración?](#is-there-an-api-rpc-way-to-apply-config)
  - [¿Cuál es una configuración mínima “sensata” para una primera instalación?](#whats-a-minimal-sane-config-for-a-first-install)
  - [¿Cómo configuro Tailscale en un VPS y me conecto desde mi Mac?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [¿Cómo conecto un nodo Mac a un Gateway remoto (Tailscale Serve)?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [¿Debería instalar en una segunda laptop o solo agregar un nodo?](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [Variables de entorno y carga de .env](#env-vars-and-env-loading)
  - [¿Cómo carga OpenClaw las variables de entorno?](#how-does-openclaw-load-environment-variables)
  - ["Inicié el Gateway vía el servicio y mis variables de entorno desaparecieron". ¿Qué hago?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [Configuré `COPILOT_GITHUB_TOKEN`, pero el estado de modelos muestra "Shell env: off". ¿Por qué?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [Sesiones y múltiples chats](#sessions-and-multiple-chats)
  - [¿Cómo inicio una conversación nueva?](#how-do-i-start-a-fresh-conversation)
  - [¿Las sesiones se reinician automáticamente si nunca envío `/new`?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [¿Hay una forma de hacer un equipo de instancias de OpenClaw con un CEO y muchos agentes?](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [¿Por qué se truncó el contexto a mitad de tarea? ¿Cómo lo evito?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [¿Cómo reinicio OpenClaw por completo pero lo mantengo instalado?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [Recibo errores de "context too large". ¿Cómo reinicio o compacto?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [¿Por qué veo "LLM request rejected: messages.N.content.X.tool_use.input: Field required"?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [¿Por qué recibo mensajes de heartbeat cada 30 minutos?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [¿Necesito agregar una "cuenta bot" a un grupo de WhatsApp?](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [¿Cómo obtengo el JID de un grupo de WhatsApp?](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [¿Por qué OpenClaw no responde en un grupo?](#why-doesnt-openclaw-reply-in-a-group)
  - [¿Los grupos/hilos comparten contexto con los mensajes directos?](#do-groupsthreads-share-context-with-dms)
  - [¿Cuántos espacios de trabajo y agentes puedo crear?](#how-many-workspaces-and-agents-can-i-create)
  - [¿Puedo ejecutar múltiples bots o chats al mismo tiempo (Slack) y cómo configurarlo?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [Modelos: valores predeterminados, selección, alias y cambio](#models-defaults-selection-aliases-switching)
  - [¿Qué es el "modelo predeterminado"?](#what-is-the-default-model)
  - [¿Qué modelo recomienda?](#what-model-do-you-recommend)
  - [¿Cómo cambio de modelo sin borrar mi configuración?](#how-do-i-switch-models-without-wiping-my-config)
  - [¿Puedo usar modelos autoalojados (llama.cpp, vLLM, Ollama)?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [¿Qué usan OpenClaw, Flawd y Krill como modelos?](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [¿Cómo cambio de modelo al vuelo (sin reiniciar)?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [¿Puedo usar GPT 5.2 para tareas diarias y Codex 5.3 para programar?](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [¿Por qué veo "Model … is not allowed" y luego no hay respuesta?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [¿Por qué veo "Unknown model: minimax/MiniMax-M2.1"?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [¿Puedo usar MiniMax como predeterminado y OpenAI para tareas complejas?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [¿opus / sonnet / gpt son atajos integrados?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [¿Cómo defino/sobrescribo atajos (alias) de modelos?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [¿Cómo agrego modelos de otros proveedores como OpenRouter o Z.AI?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [Conmutación por error de modelos y "All models failed"](#model-failover-and-all-models-failed)
  - [¿Cómo funciona la conmutación por error?](#how-does-failover-work)
  - [¿Qué significa este error?](#what-does-this-error-mean)
  - [Lista de verificación para corregir `No credentials found for profile "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [¿Por qué también intentó Google Gemini y falló?](#why-did-it-also-try-google-gemini-and-fail)
- [Perfiles de autenticación: qué son y cómo administrarlos](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [¿Qué es un perfil de autenticación?](#what-is-an-auth-profile)
  - [¿Cuáles son IDs de perfil típicos?](#what-are-typical-profile-ids)
  - [¿Puedo controlar qué perfil de autenticación se intenta primero?](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth vs clave de API: ¿cuál es la diferencia?](#oauth-vs-api-key-whats-the-difference)
- [Gateway: puertos, "ya en ejecución" y modo remoto](#gateway-ports-already-running-and-remote-mode)
  - [¿Qué puerto usa el Gateway?](#what-port-does-the-gateway-use)
  - [¿Por qué `openclaw gateway status` dice `Runtime: running` pero `RPC probe: failed`?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [¿Por qué `openclaw gateway status` muestra `Config (cli)` y `Config (service)` diferentes?](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [¿Qué significa "another gateway instance is already listening"?](#what-does-another-gateway-instance-is-already-listening-mean)
  - [¿Cómo ejecuto OpenClaw en modo remoto (el cliente se conecta a un Gateway en otro lugar)?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [La UI de Control dice "unauthorized" (o se reconecta continuamente). ¿Qué hago?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [Configuré `gateway.bind: "tailnet"` pero no puede enlazar / nada escucha](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [¿Puedo ejecutar múltiples Gateways en el mismo host?](#can-i-run-multiple-gateways-on-the-same-host)
  - [¿Qué significa "invalid handshake" / código 1008?](#what-does-invalid-handshake-code-1008-mean)
- [Registro y depuración](#logging-and-debugging)
  - [¿Dónde están los logs?](#where-are-logs)
  - [¿Cómo inicio/detengo/reinicio el servicio del Gateway?](#how-do-i-startstoprestart-the-gateway-service)
  - [Cerré mi terminal en Windows: ¿cómo reinicio OpenClaw?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [El Gateway está activo pero las respuestas nunca llegan. ¿Qué reviso?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - ["Disconnected from gateway: no reason": ¿y ahora?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands falla con errores de red. ¿Qué reviso?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [La TUI no muestra salida. ¿Qué reviso?](#tui-shows-no-output-what-should-i-check)
  - [¿Cómo detengo completamente y luego inicio el Gateway?](#how-do-i-completely-stop-then-start-the-gateway)
  - [ELI5: `openclaw gateway restart` vs `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [¿Cuál es la forma más rápida de obtener más detalles cuando algo falla?](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [Medios y adjuntos](#media-and-attachments)
  - [Mi skill generó una imagen/PDF, pero no se envió nada](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [Seguridad y control de acceso](#security-and-access-control)
  - [¿Es seguro exponer OpenClaw a mensajes directos entrantes?](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [¿La inyección de prompts solo es una preocupación para bots públicos?](#is-prompt-injection-only-a-concern-for-public-bots)
  - [¿Mi bot debería tener su propio correo, cuenta de GitHub o número telefónico?](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [¿Puedo darle autonomía sobre mis mensajes de texto y es seguro?](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [¿Puedo usar modelos más baratos para tareas de asistente personal?](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [Ejecuté `/start` en Telegram pero no recibí un código de emparejamiento](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp: ¿enviará mensajes a mis contactos? ¿Cómo funciona el emparejamiento?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [Comandos de chat, cancelación de tareas y "no se detiene"](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [¿Cómo evito que los mensajes internos del sistema aparezcan en el chat?](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [¿Cómo detengo/cancelo una tarea en ejecución?](#how-do-i-stopcancel-a-running-task)
  - [¿Cómo envío un mensaje de Discord desde Telegram? ("Cross-context messaging denied")](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [¿Por qué parece que el bot "ignora" mensajes enviados rápidamente?](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## Primeros 60 segundos si algo está roto

1. **Estado rápido (primera verificación)**

   ```bash
   openclaw status
   ```

   Resumen local rápido: SO + actualización, accesibilidad del gateway/servicio, agentes/sesiones, configuración de proveedor + problemas de runtime (cuando el gateway es accesible).

2. **Informe copiable (seguro para compartir)**

   ```bash
   openclaw status --all
   ```

   Diagnóstico de solo lectura con cola de logs (tokens ocultos).

3. **Estado de demonio + puerto**

   ```bash
   openclaw gateway status
   ```

   Muestra el runtime del supervisor vs accesibilidad RPC, la URL objetivo de la sonda y qué configuración probablemente usó el servicio.

4. **Sondeos profundos**

   ```bash
   openclaw status --deep
   ```

   Ejecuta comprobaciones de salud del gateway + sondeos de proveedores (requiere un gateway accesible). Ver [Health](/gateway/health).

5. **Ver el último log**

   ```bash
   openclaw logs --follow
   ```

   Si RPC está caído, use como alternativa:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   Los logs de archivos son independientes de los logs del servicio; ver [Logging](/logging) y [Solución de problemas](/gateway/troubleshooting).

6. **Ejecutar el doctor (reparaciones)**

   ```bash
   openclaw doctor
   ```

   Repara/migra configuración/estado + ejecuta comprobaciones de salud. Ver [Doctor](/gateway/doctor).

7. **Instantánea del Gateway**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   Solicita al gateway en ejecución una instantánea completa (solo WS). Ver [Health](/gateway/health).

## Inicio rápido y configuración inicial

### Im stuck whats the fastest way to get unstuck

Use un agente de IA local que pueda **ver su máquina**. Eso es mucho más efectivo que preguntar
en Discord, porque la mayoría de los casos de "estoy atascado" son **problemas locales de configuración o entorno** que
los ayudantes remotos no pueden inspeccionar.

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

Estas herramientas pueden leer el repo, ejecutar comandos, inspeccionar logs y ayudar a corregir
la configuración a nivel de máquina (PATH, servicios, permisos, archivos de autenticación). Proporcióneles el **checkout completo del código fuente** mediante
la instalación hackable (git):

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Esto instala OpenClaw **desde un checkout de git**, para que el agente pueda leer el código + la documentación y
razonar sobre la versión exacta que está ejecutando. Siempre puede volver a estable más tarde
volviendo a ejecutar el instalador sin `--install-method git`.

Consejo: pídale al agente que **planifique y supervise** la corrección (paso a paso), y luego ejecute solo los
comandos necesarios. Eso mantiene los cambios pequeños y más fáciles de auditar.

Si descubre un error real o una corrección, por favor abra un issue en GitHub o envíe un PR:
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

Comience con estos comandos (comparta las salidas al pedir ayuda):

```bash
openclaw status
openclaw models status
openclaw doctor
```

Lo que hacen:

- `openclaw status`: instantánea rápida de salud del gateway/agente + configuración básica.
- `openclaw models status`: verifica autenticación de proveedores + disponibilidad de modelos.
- `openclaw doctor`: valida y repara problemas comunes de configuración/estado.

Otros chequeos útiles de la CLI: `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`.

Bucle rápido de depuración: [Primeros 60 segundos si algo está roto](#first-60-seconds-if-somethings-broken).
Documentación de instalación: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating).

### What's the recommended way to install and set up OpenClaw

El repo recomienda ejecutar desde el código fuente y usar el asistente de onboarding:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

El asistente también puede construir automáticamente los assets de la UI. Después del onboarding, normalmente ejecuta el Gateway en el puerto **18789**.

Desde el código fuente (contribuidores/dev):

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw onboard
```

Si aún no tiene una instalación global, ejecútelo vía `pnpm openclaw onboard`.

### How do I open the dashboard after onboarding

El asistente abre su navegador con una URL del panel limpia (sin token) justo después del onboarding y también imprime el enlace en el resumen. Mantenga esa pestaña abierta; si no se abrió, copie y pegue la URL impresa en la misma máquina.

### How do I authenticate the dashboard token on localhost vs remote

**Localhost (misma máquina):**

- Abra `http://127.0.0.1:18789/`.
- Si solicita autenticación, pegue el token de `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`) en la configuración de la UI de Control.
- Recupérelo desde el host del Gateway: `openclaw config get gateway.auth.token` (o genere uno: `openclaw doctor --generate-gateway-token`).

**No en localhost:**

- **Tailscale Serve** (recomendado): mantenga el enlace a loopback, ejecute `openclaw gateway --tailscale serve`, abra `https://<magicdns>/`. Si `gateway.auth.allowTailscale` es `true`, los encabezados de identidad satisfacen la autenticación (sin token).
- **Enlace a tailnet**: ejecute `openclaw gateway --bind tailnet --token "<token>"`, abra `http://<tailscale-ip>:18789/`, pegue el token en la configuración del panel.
- **Túnel SSH**: `ssh -N -L 18789:127.0.0.1:18789 user@host` y luego abra `http://127.0.0.1:18789/` y pegue el token en la configuración de la UI de Control.

Consulte [Dashboard](/web/dashboard) y [Web surfaces](/web) para modos de enlace y detalles de autenticación.

### What runtime do I need

Se requiere Node **>= 22**. Se recomienda `pnpm`. Bun **no se recomienda** para el Gateway.

### Does it run on Raspberry Pi

Sí. El Gateway es liviano: la documentación indica **512MB–1GB de RAM**, **1 núcleo**, y alrededor de **500MB**
de disco como suficientes para uso personal, y señala que una **Raspberry Pi 4 puede ejecutarlo**.

Si desea margen adicional (logs, medios, otros servicios), **se recomiendan 2GB**, pero no es un mínimo estricto.

Consejo: una Pi/VPS pequeña puede alojar el Gateway, y puede emparejar **nodos** en su laptop/teléfono para
pantalla/cámara/canvas local o ejecución de comandos. Ver [Nodes](/nodes).

### Any tips for Raspberry Pi installs

Versión corta: funciona, pero espere bordes ásperos.

- Use un SO **de 64 bits** y mantenga Node >= 22.
- Prefiera la **instalación hackable (git)** para ver logs y actualizar rápido.
- Comience sin canales/skills, luego agréguelos uno por uno.
- Si encuentra problemas binarios extraños, normalmente es un **problema de compatibilidad ARM**.

Docs: [Linux](/platforms/linux), [Install](/install).

### It is stuck on wake up my friend onboarding will not hatch What now

Esa pantalla depende de que el Gateway sea accesible y esté autenticado. La TUI también envía
"Wake up, my friend!" automáticamente en el primer arranque. Si ve esa línea **sin respuesta**
y los tokens permanecen en 0, el agente nunca se ejecutó.

1. Reinicie el Gateway:

```bash
openclaw gateway restart
```

2. Verifique estado + autenticación:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

3. Si aún se cuelga, ejecute:

```bash
openclaw doctor
```

Si el Gateway es remoto, asegúrese de que el túnel/conexión Tailscale esté activa y que la UI
apunte al Gateway correcto. Ver [Remote access](/gateway/remote).

### Can I migrate my setup to a new machine Mac mini without redoing onboarding

Sí. Copie el **directorio de estado** y el **espacio de trabajo**, luego ejecute Doctor una vez. Esto
mantiene su bot "exactamente igual" (memoria, historial de sesiones, autenticación y estado de canales)
siempre que copie **ambas** ubicaciones:

1. Instale OpenClaw en la máquina nueva.
2. Copie `$OPENCLAW_STATE_DIR` (predeterminado: `~/.openclaw`) desde la máquina antigua.
3. Copie su espacio de trabajo (predeterminado: `~/.openclaw/workspace`).
4. Ejecute `openclaw doctor` y reinicie el servicio del Gateway.

Esto preserva configuración, perfiles de autenticación, credenciales de WhatsApp, sesiones y memoria. Si está en
modo remoto, recuerde que el host del Gateway es el dueño del almacén de sesiones y del espacio de trabajo.

**Importante:** si solo confirma/envía su espacio de trabajo a GitHub, está respaldando
**memoria + archivos de arranque**, pero **no** el historial de sesiones ni la autenticación. Esos viven
bajo `~/.openclaw/` (por ejemplo `~/.openclaw/agents/<agentId>/sessions/`).

Relacionado: [Migrating](/install/migrating), [Dónde viven las cosas en disco](/help/faq#where-does-openclaw-store-its-data),
[Espacio de trabajo del agente](/concepts/agent-workspace), [Doctor](/gateway/doctor),
[Modo remoto](/gateway/remote).

### Where do I see what is new in the latest version

Revise el changelog de GitHub:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

Las entradas más nuevas están arriba. Si la sección superior está marcada como **Unreleased**, la siguiente sección con fecha
es la última versión publicada. Las entradas se agrupan por **Highlights**, **Changes** y
**Fixes** (además de docs/otros cuando aplica).

### I cant access docs.openclaw.ai SSL error What now

Algunas conexiones de Comcast/Xfinity bloquean incorrectamente `docs.openclaw.ai` mediante Xfinity
Advanced Security. Desactívelo o agregue a la lista de permitidos `docs.openclaw.ai`, luego intente de nuevo. Más
detalle: [Solución de problemas](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).
Ayúdenos a desbloquearlo reportando aquí: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

Si aún no puede acceder al sitio, la documentación está reflejada en GitHub:
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### What's the difference between stable and beta

**Stable** y **beta** son **dist-tags de npm**, no líneas de código separadas:

- `latest` = estable
- `beta` = compilación temprana para pruebas

Publicamos compilaciones en **beta**, las probamos y, cuando una compilación es sólida, **promovemos
esa misma versión a `latest`**. Por eso beta y estable pueden apuntar a la
**misma versión**.

Vea qué cambió:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### How do I install the beta version and whats the difference between beta and dev

**Beta** es el dist-tag de npm `beta` (puede coincidir con `latest`).
**Dev** es la cabeza móvil de `main` (git); cuando se publica, usa el dist-tag de npm `dev`.

Comandos de una línea (macOS/Linux):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Instalador de Windows (PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

Más detalle: [Canales de desarrollo](/install/development-channels) y [Installer flags](/install/installer).

### How long does install and onboarding usually take

Guía aproximada:

- **Instalación:** 2–5 minutos
- **Onboarding:** 5–15 minutos según cuántos canales/modelos configure

Si se cuelga, use [Installer stuck](/help/faq#installer-stuck-how-do-i-get-more-feedback)
y el bucle rápido de depuración en [Im stuck](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck).

### How do I try the latest bits

Dos opciones:

1. **Canal dev (checkout de git):**

```bash
openclaw update --channel dev
```

Esto cambia a la rama `main` y actualiza desde el código fuente.

2. **Instalación hackable (desde el sitio del instalador):**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Eso le da un repo local que puede editar y luego actualizar vía git.

Si prefiere un clon limpio manual, use:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

Docs: [Update](/cli/update), [Canales de desarrollo](/install/development-channels),
[Install](/install).

### Installer stuck How do I get more feedback

Vuelva a ejecutar el instalador con **salida detallada**:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

Instalación beta con salida detallada:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

Para una instalación hackable (git):

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

Más opciones: [Installer flags](/install/installer).

### Windows install says git not found or openclaw not recognized

Dos problemas comunes en Windows:

**1) error de npm spawn git / git not found**

- Instale **Git for Windows** y asegúrese de que `git` esté en su PATH.
- Cierre y vuelva a abrir PowerShell, luego vuelva a ejecutar el instalador.

**2) openclaw no se reconoce después de instalar**

- Su carpeta bin global de npm no está en PATH.

- Verifique la ruta:

  ```powershell
  npm config get prefix
  ```

- Asegúrese de que `<prefix>\\bin` esté en PATH (en la mayoría de los sistemas es `%AppData%\\npm`).

- Cierre y vuelva a abrir PowerShell después de actualizar PATH.

Si desea la configuración más fluida en Windows, use **WSL2** en lugar de Windows nativo.
Docs: [Windows](/platforms/windows).

### The docs didnt answer my question how do I get a better answer

Use la **instalación hackable (git)** para tener todo el código y la documentación localmente, y luego pregunte
a su bot (o a Claude/Codex) _desde esa carpeta_ para que pueda leer el repo y responder con precisión.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Más detalle: [Install](/install) y [Installer flags](/install/installer).

### How do I install OpenClaw on Linux

Respuesta corta: siga la guía de Linux y luego ejecute el asistente de onboarding.

- Ruta rápida de Linux + instalación del servicio: [Linux](/platforms/linux).
- Recorrido completo: [Primeros pasos](/start/getting-started).
- Instalador + actualizaciones: [Instalación y actualizaciones](/install/updating).

### How do I install OpenClaw on a VPS

Cualquier VPS Linux funciona. Instale en el servidor y luego use SSH/Tailscale para acceder al Gateway.

Guías: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
Acceso remoto: [Gateway remoto](/gateway/remote).

### Where are the cloudVPS install guides

Mantenemos un **hub de alojamiento** con los proveedores comunes. Elija uno y siga la guía:

- [Alojamiento VPS](/vps) (todos los proveedores en un solo lugar)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

Cómo funciona en la nube: el **Gateway se ejecuta en el servidor**, y usted accede
desde su laptop/teléfono mediante la UI de Control (o Tailscale/SSH). Su estado + espacio de trabajo
viven en el servidor, así que trate al host como la fuente de la verdad y respáldelo.

Puede emparejar **nodos** (Mac/iOS/Android/headless) con ese Gateway en la nube para acceder
a pantalla/cámara/canvas locales o ejecutar comandos en su laptop mientras mantiene el
Gateway en la nube.

Hub: [Platforms](/platforms). Acceso remoto: [Gateway remoto](/gateway/remote).
Nodos: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Can I ask OpenClaw to update itself

Respuesta corta: **posible, no recomendado**. El flujo de actualización puede reiniciar el
Gateway (lo que corta la sesión activa), puede requerir un checkout limpio de git y
puede pedir confirmación. Más seguro: ejecutar actualizaciones desde una shell como operador.

Use la CLI:

```bash
openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

Si debe automatizar desde un agente:

```bash
openclaw update --yes --no-restart
openclaw gateway restart
```

Docs: [Update](/cli/update), [Updating](/install/updating).

### What does the onboarding wizard actually do

`openclaw onboard` es la ruta de configuración recomendada. En **modo local** lo guía por:

- **Configuración de modelo/autenticación** (recomendado **setup-token** de Anthropic para suscripciones Claude, compatible con OAuth de OpenAI Codex, claves de API opcionales, modelos locales LM Studio compatibles)
- **Ubicación del espacio de trabajo** + archivos de arranque
- **Configuración del Gateway** (enlace/puerto/autenticación/tailscale)
- **Proveedores** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)
- **Instalación del demonio** (LaunchAgent en macOS; unidad de usuario systemd en Linux/WSL2)
- **Comprobaciones de salud** y **selección de skills**

También avisa si su modelo configurado es desconocido o falta autenticación.

### Do I need a Claude or OpenAI subscription to run this

No. Puede ejecutar OpenClaw con **claves de API** (Anthropic/OpenAI/otros) o con
**modelos solo locales** para que sus datos permanezcan en su dispositivo. Las suscripciones (Claude
Pro/Max u OpenAI Codex) son formas opcionales de autenticar esos proveedores.

Docs: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[Modelos locales](/gateway/local-models), [Modelos](/concepts/models).

### Can I use Claude Max subscription without an API key

Sí. Puede autenticarse con un **setup-token**
en lugar de una clave de API. Esta es la ruta de suscripción.

Las suscripciones Claude Pro/Max **no incluyen una clave de API**, por lo que este es el
enfoque correcto para cuentas con suscripción. Importante: debe verificar con
Anthropic que este uso esté permitido según su política y términos de suscripción.
Si desea la ruta más explícita y soportada, use una clave de API de Anthropic.

### How does Anthropic setuptoken auth work

`claude setup-token` genera una **cadena de token** mediante la CLI de Claude Code (no está disponible en la consola web). Puede ejecutarlo en **cualquier máquina**. Elija **Anthropic token (pegar setup-token)** en el asistente o péguelo con `openclaw models auth paste-token --provider anthropic`. El token se almacena como un perfil de autenticación para el proveedor **anthropic** y se usa como una clave de API (sin auto‑refresh). Más detalle: [OAuth](/concepts/oauth).

### Where do I find an Anthropic setuptoken

No está en la Consola de Anthropic. El setup-token se genera con la **CLI de Claude Code** en **cualquier máquina**:

```bash
claude setup-token
```

Copie el token que imprime y luego elija **Anthropic token (pegar setup-token)** en el asistente. Si desea ejecutarlo en el host del gateway, use `openclaw models auth setup-token --provider anthropic`. Si ejecutó `claude setup-token` en otro lugar, péguelo en el host del gateway con `openclaw models auth paste-token --provider anthropic`. Ver [Anthropic](/providers/anthropic).

### Do you support Claude subscription auth (Claude Pro or Max)

Sí, mediante **setup-token**. OpenClaw ya no reutiliza tokens OAuth de la CLI de Claude Code; use un setup-token o una clave de API de Anthropic. Genere el token en cualquier lugar y péguelo en el host del gateway. Ver [Anthropic](/providers/anthropic) y [OAuth](/concepts/oauth).

Nota: el acceso por suscripción de Claude está regido por los términos de Anthropic. Para cargas de trabajo de producción o multiusuario, las claves de API suelen ser la opción más segura.

### Why am I seeing HTTP 429 ratelimiterror from Anthropic

Eso significa que su **cuota/límite de tasa de Anthropic** está agotado para la ventana actual. Si
usa una **suscripción Claude** (setup-token u OAuth de Claude Code), espere a que se
restablezca la ventana o mejore su plan. Si usa una **clave de API de Anthropic**, revise la Consola de Anthropic
para uso/facturación y aumente límites según sea necesario.

Consejo: configure un **modelo de respaldo** para que OpenClaw pueda seguir respondiendo mientras un proveedor está limitado por tasa.
Ver [Models](/cli/models) y [OAuth](/concepts/oauth).

### Is AWS Bedrock supported

Sí, mediante el proveedor **Amazon Bedrock (Converse)** de pi‑ai con **configuración manual**. Debe proporcionar credenciales/región de AWS en el host del gateway y agregar una entrada de proveedor Bedrock en su configuración de modelos. Ver [Amazon Bedrock](/providers/bedrock) y [Proveedores de modelos](/providers/models). Si prefiere un flujo de claves administradas, un proxy compatible con OpenAI delante de Bedrock sigue siendo una opción válida.

### How does Codex auth work

OpenClaw admite **OpenAI Code (Codex)** mediante OAuth (inicio de sesión de ChatGPT). El asistente puede ejecutar el flujo OAuth y establecerá el modelo predeterminado en `openai-codex/gpt-5.3-codex` cuando corresponda. Ver [Proveedores de modelos](/concepts/model-providers) y [Wizard](/start/wizard).

### Do you support OpenAI subscription auth Codex OAuth

Sí. OpenClaw admite completamente **OAuth de suscripción de OpenAI Code (Codex)**. El asistente de onboarding
puede ejecutar el flujo OAuth por usted.

Ver [OAuth](/concepts/oauth), [Proveedores de modelos](/concepts/model-providers) y [Wizard](/start/wizard).

### How do I set up Gemini CLI OAuth

Gemini CLI usa un **flujo de autenticación por plugin**, no un client id o secret en `openclaw.json`.

Pasos:

1. Habilite el plugin: `openclaw plugins enable google-gemini-cli-auth`
2. Inicie sesión: `openclaw models auth login --provider google-gemini-cli --set-default`

Esto almacena tokens OAuth en perfiles de autenticación en el host del gateway. Detalles: [Proveedores de modelos](/concepts/model-providers).

### Is a local model OK for casual chats

Por lo general no. OpenClaw necesita contexto grande y seguridad sólida; tarjetas pequeñas truncan y filtran. Si debe hacerlo, ejecute la **versión más grande** de MiniMax M2.1 que pueda localmente (LM Studio) y consulte [/gateway/local-models](/gateway/local-models). Los modelos más pequeños/cuantizados aumentan el riesgo de inyección de prompts; ver [Security](/gateway/security).

### How do I keep hosted model traffic in a specific region

Elija endpoints fijados por región. OpenRouter expone opciones alojadas en EE. UU. para MiniMax, Kimi y GLM; elija la variante alojada en EE. UU. para mantener los datos en la región. Aún puede listar Anthropic/OpenAI junto a estos usando `models.mode: "merge"` para que los respaldos sigan disponibles respetando el proveedor regional seleccionado.

### Do I have to buy a Mac Mini to install this

No. OpenClaw se ejecuta en macOS o Linux (Windows vía WSL2). Un Mac mini es opcional: algunas personas
compran uno como host siempre encendido, pero un VPS pequeño, servidor doméstico o una caja tipo Raspberry Pi también funciona.

Solo necesita un Mac **para herramientas exclusivas de macOS**. Para iMessage, use [BlueBubbles](/channels/bluebubbles) (recomendado): el servidor BlueBubbles se ejecuta en cualquier Mac, y el Gateway puede ejecutarse en Linux u otro lugar. Si desea otras herramientas exclusivas de macOS, ejecute el Gateway en un Mac o empareje un nodo macOS.

Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes), [Modo remoto de Mac](/platforms/mac/remote).

### Do I need a Mac mini for iMessage support

Necesita **algún dispositivo macOS** con sesión iniciada en Mensajes. **No** tiene que ser un Mac mini:
cualquier Mac funciona. **Use [BlueBubbles](/channels/bluebubbles)** (recomendado) para iMessage: el servidor BlueBubbles se ejecuta en macOS, mientras que el Gateway puede ejecutarse en Linux u otro lugar.

Configuraciones comunes:

- Ejecutar el Gateway en Linux/VPS y el servidor BlueBubbles en cualquier Mac con sesión iniciada en Mensajes.
- Ejecutar todo en el Mac si desea la configuración más simple en una sola máquina.

Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),
[Modo remoto de Mac](/platforms/mac/remote).

### If I buy a Mac mini to run OpenClaw can I connect it to my MacBook Pro

Sí. El **Mac mini puede ejecutar el Gateway**, y su MacBook Pro puede conectarse como
**nodo** (dispositivo complementario). Los nodos no ejecutan el Gateway: proporcionan capacidades adicionales
como pantalla/cámara/canvas y `system.run` en ese dispositivo.

Patrón común:

- Gateway en el Mac mini (siempre encendido).
- MacBook Pro ejecuta la app de macOS o un host de nodo y se empareja con el Gateway.
- Use `openclaw nodes status` / `openclaw nodes list` para verlo.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Can I use Bun

Bun **no se recomienda**. Observamos errores de runtime, especialmente con WhatsApp y Telegram.
Use **Node** para Gateways estables.

Si aun así desea experimentar con Bun, hágalo en un Gateway no productivo
sin WhatsApp/Telegram.

### Telegram what goes in allowFrom

`channels.telegram.allowFrom` es **el ID de usuario de Telegram del remitente humano** (numérico, recomendado) o `@username`. No es el nombre de usuario del bot.

Más seguro (sin bot de terceros):

- Envíe un DM a su bot y luego ejecute `openclaw logs --follow` y lea `from.id`.

API oficial del bot:

- Envíe un DM a su bot y luego llame a `https://api.telegram.org/bot<bot_token>/getUpdates` y lea `message.from.id`.

Terceros (menos privado):

- Envíe un DM a `@userinfobot` o `@getidsbot`.

Ver [/channels/telegram](/channels/telegram#access-control-dms--groups).

### Can multiple people use one WhatsApp number with different OpenClaw instances

Sí, mediante **enrutamiento multi‑agente**. Vincule el **DM** de WhatsApp de cada remitente (peer `kind: "dm"`, remitente E.164 como `+15551234567`) a un `agentId` distinto, para que cada persona tenga su propio espacio de trabajo y almacén de sesiones. Las respuestas siguen viniendo de la **misma cuenta de WhatsApp**, y el control de acceso a DM (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) es global por cuenta de WhatsApp. Ver [Enrutamiento multi‑agente](/concepts/multi-agent) y [WhatsApp](/channels/whatsapp).

### Can I run a fast chat agent and an Opus for coding agent

Sí. Use enrutamiento multi‑agente: asigne a cada agente su propio modelo predeterminado y luego vincule rutas entrantes (cuenta del proveedor o peers específicos) a cada agente. Un ejemplo de configuración vive en [Enrutamiento multi‑agente](/concepts/multi-agent). Ver también [Modelos](/concepts/models) y [Configuración](/gateway/configuration).

### Does Homebrew work on Linux

Sí. Homebrew admite Linux (Linuxbrew). Configuración rápida:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

Si ejecuta OpenClaw vía systemd, asegúrese de que el PATH del servicio incluya `/home/linuxbrew/.linuxbrew/bin` (o su prefijo brew) para que las herramientas instaladas con `brew` se resuelvan en shells no interactivos.
Las compilaciones recientes también anteponen directorios bin comunes de usuario en servicios systemd de Linux (por ejemplo `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/.bun/bin`) y respetan `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR` y `FNM_DIR` cuando están configurados.

### What's the difference between the hackable git install and npm install

- **Instalación hackable (git):** checkout completo del código fuente, editable, ideal para contribuyentes.
  Usted ejecuta compilaciones localmente y puede modificar código/documentación.
- **Instalación npm:** instalación global de la CLI, sin repo, ideal para “solo ejecutarlo”.
  Las actualizaciones provienen de dist-tags de npm.

Docs: [Primeros pasos](/start/getting-started), [Updating](/install/updating).

### Can I switch between npm and git installs later

Sí. Instale la otra variante y luego ejecute Doctor para que el servicio del gateway apunte al nuevo entrypoint.
Esto **no elimina sus datos**: solo cambia la instalación del código de OpenClaw. Su estado
(`~/.openclaw`) y espacio de trabajo (`~/.openclaw/workspace`) permanecen intactos.

De npm → git:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

De git → npm:

```bash
npm install -g openclaw@latest
openclaw doctor
openclaw gateway restart
```

Doctor detecta una discrepancia del entrypoint del servicio del gateway y ofrece reescribir la configuración del servicio para que coincida con la instalación actual (use `--repair` en automatización).

Consejos de respaldo: ver [Estrategia de respaldo](/help/faq#whats-the-recommended-backup-strategy).

### Should I run the Gateway on my laptop or a VPS

Respuesta corta: **si desea confiabilidad 24/7, use un VPS**. Si quiere la menor fricción y está bien con suspensiones/reinicios, ejecútelo localmente.

**Laptop (Gateway local)**

- **Pros:** sin costo de servidor, acceso directo a archivos locales, ventana de navegador visible.
- **Contras:** suspensión/cortes de red = desconexiones, actualizaciones/reinicios del SO interrumpen, debe mantenerse despierta.

**VPS / nube**

- **Pros:** siempre encendido, red estable, sin problemas de suspensión, más fácil de mantener en ejecución.
- **Contras:** a menudo headless (use capturas), acceso remoto a archivos, debe usar SSH para actualizaciones.

**Nota específica de OpenClaw:** WhatsApp/Telegram/Slack/Mattermost (plugin)/Discord funcionan bien desde un VPS. El único intercambio real es **navegador headless** vs ventana visible. Ver [Browser](/tools/browser).

**Predeterminado recomendado:** VPS si ha tenido desconexiones del gateway antes. Local es excelente cuando usa activamente el Mac y quiere acceso a archivos locales o automatización de UI con navegador visible.

### How important is it to run OpenClaw on a dedicated machine

No es obligatorio, pero **se recomienda para confiabilidad y aislamiento**.

- **Host dedicado (VPS/Mac mini/Pi):** siempre encendido, menos interrupciones por suspensión/reinicio, permisos más limpios, más fácil de mantener en ejecución.
- **Laptop/desktop compartidos:** totalmente bien para pruebas y uso activo, pero espere pausas cuando la máquina duerma o se actualice.

Si quiere lo mejor de ambos mundos, mantenga el Gateway en un host dedicado y empareje su laptop como **nodo** para herramientas locales de pantalla/cámara/exec. Ver [Nodes](/nodes).
Para orientación de seguridad, lea [Security](/gateway/security).

### What are the minimum VPS requirements and recommended OS

OpenClaw es liviano. Para un Gateway básico + un canal de chat:

- **Mínimo absoluto:** 1 vCPU, 1GB RAM, ~500MB de disco.
- **Recomendado:** 1–2 vCPU, 2GB RAM o más para margen (logs, medios, múltiples canales). Las herramientas de nodos y la automatización de navegador pueden consumir recursos.

SO: use **Ubuntu LTS** (o cualquier Debian/Ubuntu moderno). La ruta de instalación en Linux está mejor probada allí.

Docs: [Linux](/platforms/linux), [Alojamiento VPS](/vps).

### Can I run OpenClaw in a VM and what are the requirements

Sí. Trate una VM igual que un VPS: debe estar siempre encendida, ser accesible y tener suficiente
RAM para el Gateway y cualquier canal que habilite.

Guía base:

- **Mínimo absoluto:** 1 vCPU, 1GB RAM.
- **Recomendado:** 2GB RAM o más si ejecuta múltiples canales, automatización de navegador o herramientas de medios.
- **SO:** Ubuntu LTS u otro Debian/Ubuntu moderno.

Si está en Windows, **WSL2 es la configuración de estilo VM más sencilla** y tiene la mejor compatibilidad de herramientas. Ver [Windows](/platforms/windows), [Alojamiento VPS](/vps).
Si ejecuta macOS en una VM, ver [macOS VM](/install/macos-vm).

## What is OpenClaw?

### What is OpenClaw in one paragraph

OpenClaw es un asistente de IA personal que usted ejecuta en sus propios dispositivos. Responde en las superficies de mensajería que ya usa (WhatsApp, Telegram, Slack, Mattermost (plugin), Discord, Google Chat, Signal, iMessage, WebChat) y también puede hacer voz + un Canvas en vivo en plataformas compatibles. El **Gateway** es el plano de control siempre encendido; el asistente es el producto.

### What's the value proposition

OpenClaw no es “solo un wrapper de Claude”. Es un **plano de control local‑first** que le permite ejecutar un
asistente capaz en **su propio hardware**, accesible desde las apps de chat que ya usa, con
sesiones con estado, memoria y herramientas, sin entregar el control de sus flujos de trabajo a un
SaaS alojado.

Aspectos destacados:

- **Sus dispositivos, sus datos:** ejecute el Gateway donde quiera (Mac, Linux, VPS) y mantenga
  el espacio de trabajo + historial de sesiones locales.
- **Canales reales, no un sandbox web:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc.,
  además de voz móvil y Canvas en plataformas compatibles.
- **Agnóstico de modelos:** use Anthropic, OpenAI, MiniMax, OpenRouter, etc., con enrutamiento por agente
  y conmutación por error.
- **Opción solo local:** ejecute modelos locales para que **todos los datos permanezcan en su dispositivo** si lo desea.
- **Enrutamiento multi‑agente:** agentes separados por canal, cuenta o tarea, cada uno con su propio
  espacio de trabajo y valores predeterminados.
- **Código abierto y hackable:** inspeccione, extienda y auto‑aloje sin bloqueo de proveedor.

Docs: [Gateway](/gateway), [Channels](/channels), [Multi‑agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### I just set it up what should I do first

Buenos primeros proyectos:

- Construir un sitio web (WordPress, Shopify o un sitio estático simple).
- Prototipar una app móvil (esquema, pantallas, plan de API).
- Organizar archivos y carpetas (limpieza, nombres, etiquetas).
- Conectar Gmail y automatizar resúmenes o seguimientos.

Puede manejar tareas grandes, pero funciona mejor cuando las divide en fases y
usa sub‑agentes para trabajo en paralelo.

### What are the top five everyday use cases for OpenClaw

Las victorias cotidianas suelen verse así:

- **Briefings personales:** resúmenes del correo, calendario y noticias que le importan.
- **Investigación y redacción:** investigación rápida, resúmenes y primeros borradores para correos o documentos.
- **Recordatorios y seguimientos:** avisos y listas de verificación impulsadas por cron o heartbeat.
- **Automatización de navegador:** completar formularios, recopilar datos y repetir tareas web.
- **Coordinación entre dispositivos:** envíe una tarea desde su teléfono, deje que el Gateway la ejecute en un servidor y reciba el resultado en el chat.

### Can OpenClaw help with lead gen outreach ads and blogs for a SaaS

Sí, para **investigación, calificación y redacción**. Puede escanear sitios, crear listas cortas,
resumir prospectos y redactar borradores de outreach o anuncios.

Para **outreach o campañas**, mantenga a un humano en el circuito. Evite spam, cumpla leyes locales y
políticas de plataformas, y revise todo antes de enviarlo. El patrón más seguro es dejar
que OpenClaw redacte y usted apruebe.

Docs: [Security](/gateway/security).

### What are the advantages vs Claude Code for web development

OpenClaw es un **asistente personal** y capa de coordinación, no un reemplazo de IDE. Use
Claude Code o Codex para el bucle de programación más rápido dentro de un repo. Use OpenClaw cuando
quiera memoria duradera, acceso entre dispositivos y orquestación de herramientas.

Ventajas:

- **Memoria persistente + espacio de trabajo** entre sesiones
- **Acceso multiplataforma** (WhatsApp, Telegram, TUI, WebChat)
- **Orquestación de herramientas** (navegador, archivos, programación, hooks)
- **Gateway siempre encendido** (ejecute en un VPS, interactúe desde cualquier lugar)
- **Nodos** para navegador/pantalla/cámara/exec locales

Showcase: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## Habilidades y automatización

### ¿Cómo personalizo las habilidades sin mantener el repositorio sucio

Usar anulaciones administradas en lugar de editar la copia del repo. Pon tus cambios en `~/.openclaw/skills/<name>/SKILL.md` (o añade una carpeta a través de `skills.load.extraDirs` en `~/.openclaw/openclaw.json`). Precedencia es `<workspace>/Skills` > `~/.openclaw/Skills` > empaquetado, así que las sobrescrituras administradas ganan sin tocar git. Sólo las ediciones que merecen la pena realizar deben vivir en el repositorio y salir como PRs.

### ¿Puedo cargar habilidades desde una carpeta personalizada

Sí. Añade directorios adicionales a través de `skills.load.extraDirs` en `~/.openclaw/openclaw.json` (precedencia más baja). La precedencia predeterminada permanece: `<workspace>/skills` → `~/.openclaw/skills` → empaquetado → `skills.load.extraDirs`. `clawhub` se instala en `./skills` por defecto, que OpenClaw trata como `<workspace>/skills`.

### Cómo puedo utilizar diferentes modelos para diferentes tareas

Hoy los patrones soportados son:

- **Trabajos Cronales**: trabajos aislados pueden establecer una anulación `model` por trabajo.
- **Subagentes**: enrutar tareas para separar agentes con diferentes modelos predeterminados.
- **Interruptor a demanda**: usa `/model` para cambiar el modelo de sesión actual en cualquier momento.

Ver [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent), y [Slash commands](/tools/slash-commands).

### El bot se congela mientras realizo un trabajo pesado ¿Cómo puedo descargarlo

Usa **subagentes** para tareas largas o paralelas. Los subagentes se ejecutan en su propia sesión,
devuelve un resumen y mantén tu chat principal respondiendo.

Pide a tu bot "generar un subagente para esta tarea" o usa `/subagents`.
Usa `/status` en el chat para ver lo que el Gateway está haciendo ahora mismo (y si está ocupado).

Consejo: tareas largas y subagentes consumen fichas. Si el costo es una preocupación, establece un modelo
más barato para los subagentes a través de `agents.defaults.subagents.model`.

Docs: [Sub-agents](/tools/subagents).

### Cron o recordatorios no disparan ¿Qué debo comprobar

Cron se ejecuta dentro del proceso Gateway. Si el Gateway no se está ejecutando continuamente,
trabajos programados no se ejecutarán.

Lista de verificación:

- Confirmar que cron está habilitado (`cron.enabled`) y `OPENCLAW_SKIP_CRON` no está definido.
- Compruebe que el Gateway está funcionando 24/7 (sin reiniciarse).
- Verifique la configuración de zona horaria para el trabajo (`--tz` vs zona horaria del host).

Debug:

```bash
openclaw cron ejecuta <jobId> --force
openclaw cron ejecuta --id <jobId> --limit 50
```

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat).

### ¿Cómo puedo instalar habilidades en Linux

Usa **ClawHub** (CLI) o suelta habilidades en tu espacio de trabajo. La interfaz de habilidades de macOS no está disponible en Linux.
Ver habilidades en [https://clawhub.com](https://clawhub.com).

Instalar ClawHub CLI (elija un gestor de paquetes):

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### Puede OpenClaw ejecutar tareas en un programa o continuamente en segundo plano

Sí. Usar el planificador de Gateway:

- **Trabajos cronales** para tareas programadas o recurrentes (persisten entre reinicios).
- **Heartbeat** para comprobaciones periódicas de la "sesión principal".
- **Trabajos aislados** para agentes autónomos que publican resúmenes o entregan a chats.

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),
[Heartbeat](/gateway/heartbeat).

### ¿Puedo usar las habilidades de Apple macOS de Linux?

No directamente. las habilidades de macOS son compuestas por `metadata.openclaw.os` más los binarios requeridos, y las habilidades solo aparecen en el prompt del sistema cuando son elegibles en el **host Gateway**. En Linux, `darwin`-only skills (como `apple-notes`, `apple-reminders`, `things-mac`) no se cargará a menos que se sobreescriba la puerta.

Tienes tres patrones soportados:

\*\*Opción A - ejecuta el Gateway en un Mac (más simple). \*
Ejecute la puerta de enlace donde existen los binarios macOS, luego conéctese desde Linux en [modo remoto](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) o sobre escala posterior. La carga de habilidades normalmente porque el host de la puerta de enlace es macOS.

\*\*Opción B - usa un nodo macOS (no SSH). \*
Ejecute el Gateway en Linux, empareja un nodo macOS (aplicación menubar), y establezca **Node Run Commands** en "Siempre Preguntar" o "Siempre Permitir" en el Mac. OpenClaw puede tratar las habilidades sólo macOS como elegibles cuando existen los binarios necesarios en el nodo. El agente ejecuta esas habilidades a través de la herramienta `nodos`. Si selecciona "Preguntar siempre", aprobando "Siempre Permitir" en la línea de comandos añade ese comando a la lista permitida.

\*\*Opción C - binarios macOS proxy sobre SSH (avanzado). \*
Mantenga el Gateway en Linux, pero haga que los binarios CLI necesarios resuelvan a los envoltorios SSH que se ejecutan en un Mac. Luego anule la habilidad para permitir que Linux se mantenga elegible.

1. Crea un envoltorio SSH para el binario (ejemplo: `memo` para Notas de Apple):

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

2. Pon el envoltorio en `PATH` en el host Linux (por ejemplo `~/bin/memo`).

3. Anular los metadatos de habilidad (espacio de trabajo o `~/.openclaw/skills`) para permitir Linux:

   ```markdown
   ---
   name: apple-notes
   description: Manage Apple Notes via the memo CLI on macOS.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
   ---
   ```

4. Comienza una nueva sesión para que las habilidades se actualizen.

### ¿Tienes una noción o integración de HeyGen

No integrado hoy.

Opciones:

- **Habilidad personalizada / plugin:** mejor para un acceso confiable a la API (Notion/HeyGen ambos tienen APIs).
- **Automatización del navegador:** funciona sin código pero es más lento y frágil.

Si desea mantener el contexto por cliente (flujos de trabajo de agencia), un patrón simple es:

- Una página de noción por cliente (contexto + preferencias + trabajo activo).
- Pida al agente que busque esa página al inicio de una sesión.

Si quieres una integración nativa, abre una solicitud de característica o construye una habilidad
apuntando esas APIs.

Instalar habilidades:

```bash
clawhub instala <skill-slug>
clawhub update --all
```

ClawHub se instala en `. habilidades` bajo tu directorio actual (o vuelve a tu espacio de trabajo OpenClaw configurado); OpenClaw lo trata como `<workspace>/habilidad` en la siguiente sesión. Para habilidades compartidas entre los agentes, colocalas en `~/.openclaw/skills/<name>/SKILL.md`. Algunas habilidades esperan binarios instalados a través de Homebrew; en Linux eso significa Linuxbrew (ver la entrada Homebrew Linux FAQ arriba). Ver [Skills](/tools/skills) y [ClawHub](/tools/clawhub).

### ¿Cómo instalo la extensión Chrome para la adquisición del navegador

Utilice el instalador integrado, luego cargue la extensión desempaquetada en Chrome:

```bash
openclaw browser extension install
openclaw browser extension path
```

Luego Chrome → `chrome://extensions` → habilitar "Modo desarrollador" → "Cargar desempaquetado" → elegir esa carpeta.

Guía completa (incluyendo Gateway remoto + notas de seguridad): [Chrome extension](/tools/chrome-extension)

Si la puerta de enlace se ejecuta en la misma máquina que Chrome (configuración por defecto), por lo general **no** necesitas nada adicional.
Si el Gateway se ejecuta en otro lugar, ejecute un host de nodo en la máquina del navegador para que el Gateway pueda proxiar las acciones del navegador.
Todavía necesita hacer clic en el botón de extensión de la pestaña que desea controlar (no se adjunta automáticamente).

## Arenas de arena y memoria

### Hay un documento de sandboxing dedicado

Sí. Vea [Sandboxing](/gateway/sandboxing). Para configuración específica de Docker (puerta de enlace completa en imágenes Docker o sandbox), vea [Docker](/install/docker).

### Docker se siente limitado ¿Cómo puedo habilitar todas las funciones

La imagen predeterminada prioriza la seguridad y se ejecuta como el usuario `node`, por lo que no incluye paquetes del sistema, Homebrew ni navegadores incluidos. Para una configuración más completa:

- Persista `/home/node` con `OPENCLAW_HOME_VOLUME` para que los cachés sobrevivan.
- Captura deps del sistema en la imagen con `OPENCLAW_DOCKER_APT_PACKAGES`.
- Instalar navegadores Playwright a través del CLI empaquetado:
  `node /app/node_modules/playwright-core/cli.js install chromium`
- Establece `PLAYWRIGHT_BROWSERS_PATH` y asegúrate de que la ruta persiste.

Docs: [Docker](/install/docker), [Browser](/tools/browser).

**Puedo mantener los DMs personales pero hacer públicos los grupos con un solo agente**

Sí, si tu tráfico privado es **DMs** y tu tráfico público es **grupos**.

Usa `agents.defaults.sandbox.mode: "non-main"` así que las sesiones de grupo/canal (no las claves principales) se ejecutan en Docker, mientras que la sesión principal de DM permanece en el anfitrión. Luego restringir qué herramientas están disponibles en sesiones de sandboiled a través de `tools.sandbox.tools`.

Configuración del tutorial + configuración de ejemplo: [Grupos: DMs personales + grupos públicos](/channels/groups#pattern-personal-dms-public-groups-single-agent)

Referencia de configuración de clave: [configuración de pasarela de enlaces](/gateway/configuration#agentsdefaultssandbox)

### ¿Cómo enlazo una carpeta host en el sandbox

Establece `agents.defaults.sandbox.docker.binds` a `["host:path:mode"]` (por ejemplo, `"/home/user/src:/src:ro"`). Global + por agente se une a la fusión; los enlaces por agente se ignoran cuando `scope: "shared"`. Use `:ro` para cualquier cosa sensible y recuerde que se saltan las paredes del sistema de archivos sandbox. Vea [Sandboxing](/gateway/sandboxing#custom-bind-mounts) y [Sandbox vs Tool Policy vs tilizated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) para ver ejemplos y notas de seguridad.

### Cómo funciona la memoria

La memoria OpenClaw es sólo archivos Markdown en el espacio de trabajo del agente:

- Notas diarias en `memory/AAY-MM-DD.md`
- Notas a largo plazo supervisadas en `MEMORY.md` (solo sesiones principal/privadas)

OpenClaw también ejecuta una **flush silenciosa de memoria de precompacción** para recordarle al modelo
que escriba notas duraderas antes de la compacción automática. Esto solo se ejecuta cuando el espacio de trabajo
es escribible (sandboxes de solo lectura lo omitir). Vea [Memoria](/concepts/memory).

### La memoria sigue olvidando las cosas cómo hacer que se pegue

Pídele al bot que **escriba el hecho a la memoria**. Las notas de largo nivel pertenecen a `MEMORY.md`,
el contexto de corto plazo entra en `memory/YYY-MM-DD.md`.

Este sigue siendo un ámbito que estamos mejorando. Ayuda a recordar al modelo para almacenar recuerdos;
sabrá qué hacer. Si sigue olvidando, verifique que el Gateway esté utilizando el mismo espacio de trabajo
en cada ejecución.

Docs: [Memory](/concepts/memory), [Espacio de trabajo del agente](/concepts/agent-workspace).

### La búsqueda semántica de memoria requiere una clave API OpenAI

Sólo si usas **incrustaciones OpenAI**. Codex OAuth cubre chat/terminaciones y
**no** otorga acceso a incrustaciones así que **iniciar sesión con Codex (OAuth o
CLI de Codex)** no ayuda para la búsqueda semántica de memoria. OpenAI incrusta
todavía necesita una clave API real (`OPENAI_API_KEY` o `models.providers.openai.apiKey`).

Si no establece un proveedor explícitamente, OpenClaw auto-selecciona un proveedor cuando
puede resolver una clave API (perfiles de autenticación, `models.providers.*.apiKey`, o variables de env).
Prefiere OpenAI si una clave OpenAI se resuelve, de lo contrario Gemini si una clave
de Gemini se resuelve. Si ninguna de las dos claves está disponible, la búsqueda en memoria permanece deshabilitada hasta que la configures. Si tiene una ruta de modelo local configurada y presente, OpenClaw
prepara `local`.

Si prefieres permanecer local, establece `memorySearch.provider = "local"` (y opcionalmente
`memorySearch.fallback = "ninguno"`). Si quieres insertar Gemini, establece
`memorySearch.provider = "gemini"` y proporciona `GEMINI_API_KEY` (o
`memorySearch.remote.apiKey`). Soportamos **OpenAI, Gemini o local** incrustando modelos* vea [Memory](/concepts/memory) para los detalles de configuración.

### ¿La memoria persiste para siempre cuáles son los límites

Los archivos de memoria viven en el disco duro y persisten hasta que los elimines. El límite es tu Almacenamiento
, no el modelo. El **contexto de sesión** todavía está limitado por la ventana contextual del modelo
, así que las conversaciones largas pueden compactar o truncar. Por eso existe la búsqueda de memoria: solo trae de vuelta al contexto las partes relevantes.

Docs: [Memory](/concepts/memory), [Context](/concepts/context).

## Donde las cosas viven en el disco

### Se utiliza todos los datos con OpenClaw guardados localmente

No - **El estado de OpenClaw es local**, pero **los servicios externos siguen viendo lo que los envias**.

- **Local por defecto:** sesiones, archivos de memoria, configuración y espacio de trabajo en vivo en el host de Gateway
  (`~/.openclaw` + tu directorio de espacio de trabajo).
- **Remoto por necesidad:** mensajes que envías a los proveedores de modelos (Anthropic/OpenAI/etc.) ir a
  sus APIs, y plataformas de chat (WhatsApp/Telegram/Slack/etc.) almacenar los datos de los mensajes en sus servidores
  .
- **Controla la huella:** El uso de modelos locales mantiene indicaciones en tu máquina, pero el tráfico
  del canal sigue pasando por los servidores del canal.

Relacionado: [Espacio de trabajo del agent](/concepts/agent-workspace), [Memory](/concepts/memory).

### ¿Dónde almacena sus datos OpenClaw

Todo vive bajo `$OPENCLAW_STATE_DIR` (por defecto: `~/.openclaw`):

| Ruta                                                            | Propósito                                                                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | Configuración principal (JSON5)                                                    |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | Importación de OAuth heredada (copiada en perfiles de autenticación en primer uso) |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | Perfiles de autenticación (OAuth + claves API)                                     |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | Caché de autenticación de ejecución (administrado automáticamente)                 |
| `$OPENCLAW_STATE_DIR/credentials/`                              | Estado del proveedor (por ejemplo, `whatsapp/<accountId>/creds.json`)              |
| `$OPENCLAW_STATE_DIR/agents/`                                   | Estado por agente (agentDir + sesiones)                                            |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | Historial de conversación y estado (por agente)                                    |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | Metadatos de sesión (por agente)                                                   |

Ruta heredada de un solo agente: `~/.openclaw/agent/*` (migrado por `openclaw doctor`).

Tu **espacio de trabajo** (AGENTS.md, archivos de memoria, habilidades, etc.) está separado y configurado a través de `agents.defaults.workspace` (por defecto: `~/.openclaw/workspace`).

### ¿Dónde debe vivir AGENTsmalld SOULmd USERmd MEMORYmd

Estos archivos viven en el **espacio de trabajo de agentes**, no en `~/.openclaw`.

- **Espacio de trabajo (por agente)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md` (o `memory.md`), `memory/YYY-MM-DD.md`, opcional `HEARTBEAT.md`.
- **Directorio de estado (`~/.openclaw`)**: configuración, credenciales, perfiles de auth, sesiones, registros,
  y habilidades compartidas (`~/.openclaw/skills`).

Espacio de trabajo por defecto es `~/.openclaw/workspace`, configurable por ejemplo:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

Si el bot "olvida" después de un reinicio, confirmar que el Gateway está usando el mismo espacio de trabajoformat@@0
en cada lanzamiento (y recordar: el modo remoto utiliza el espacio de trabajo de **host de puerta de enlace**
, no es tu portátil local).

Consejo: si quieres un comportamiento o preferencia durable, pide al bot que lo **escriba en
AGENTS. d o MEMORY.md** en lugar de depender del historial de chat.

Ver [Espacio de trabajo del agente](/concepts/agent-workspace) y [Memory](/concepts/memory).

### ¿Cuál es la estrategia de copia de seguridad recomendada

Pon tu **espacio de trabajo de agentes** en un repositorio de git **privado** y haz una copia de seguridad en algún lugar privado
(por ejemplo GitHub privado). Esto captura la memoria + archivos AGENTS/SOUL/USUARIO
, y le permite restaurar el "mente" del asistente más adelante.

**no** confirme nada bajo `~/.openclaw` (credenciales, sesiones, tokens).
Si necesita una restauración completa, haga una copia de seguridad tanto del área de trabajo como del directorio de estado
por separado (vea la pregunta de migración de arriba).

Docs: [Espacio de trabajo del agente](/concepts/agent-workspace).

### ¿Cómo desinstalo completamente OpenClaw

Ver la guía dedicada: [Uninstall](/install/uninstall).

### Los agentes pueden trabajar fuera del área de trabajo

Sí. El espacio de trabajo es el **cwd por defecto** y el anclaje de memoria, no un sandbox duro.
Las rutas relativas se resuelven dentro del espacio de trabajo, pero las rutas absolutas pueden acceder a otras ubicaciones de host
a menos que el sandboxing esté activado. Si necesita aislamiento, utilice la configuración
[`agents.defaults.sandbox`](/gateway/sandboxing) o por agente. Si quieres que un repositorio sea el directorio de trabajo predeterminado, apunta el `workspace` de ese agente a la raíz del repositorio. El repositorio de OpenClaw es solo código fuente; mantén el espacio de trabajo
separado a menos que intencionalmente quieras que el agente trabaje dentro de él.

Ejemplo (repo como cwd predeterminado):

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### Estoy en modo remoto donde está el almacén de sesiones

El estado de la sesión es propiedad del **host de la pasarela de enlace**. Si está en modo remoto, la tienda de sesiones que le importa está en la máquina remota, no en su computadora portátil local. Ver [Gestión de la sesión](/concepts/session).

## Configurar conceptos básicos

### ¿Qué formato es la configuración dónde está

OpenClaw lee una configuración opcional **JSON5** de `$OPENCLAW_CONFIG_PATH` (por defecto: `~/.openclaw/openclaw.json`):

```
$OPENCLAW_CONFIG_PATH
```

Si el archivo está ausente, utiliza valores predeterminados seguros (incluyendo un espacio de trabajo predeterminado de `~/.openclaw/workspace`).

### Establezco lan o tailnet de gatewaybind y ahora nada escucha la interfaz de usuario dice no autorizado

Los enlaces no loopback **requieren autentificación**. Configura `gateway.auth.mode` + `gateway.auth.token` (o usa `OPENCLAW_GATEWAY_TOKEN`).

```json5
{
  gateway: {
    bind: "lan",
    auth: {
      mode: "token",
      token: "replace-me",
    },
  },
}
```

Notas:

- `gateway.remote.token` es sólo para **llamadas remotas a CLI**; no habilita la autenticación local de la puerta de enlace.
- El Control UI se autentifica a través de `connect.params.auth.token` (almacenado en la configuración de la aplicación/UI). Evita poner tokens en URLs.

### ¿Por qué necesito un token en localhost ahora

El asistente genera un token de puerta de enlace por defecto (incluso en bucle) así que **los clientes locales de WS deben autenticarse**. Esto impide que otros procesos locales llamen a la puerta de enlace. Pegue el token en la configuración de la interfaz de control (o la configuración del cliente) para conectarse.

Si **realmente** quieres abrir loopback, elimina `gateway.auth` de tu configuración. El doctor puede generar un token para usted en cualquier momento: `openclaw doctor --generate-gateway-token`.

### Tengo que reiniciar después de cambiar la configuración

El Gateway reproduce la configuración y soporta la recarga de hot:

- `gateway.reload.mode: "hybrid"` (por defecto): caliente aplicar cambios seguros, reiniciar para los críticos
- `hot`, `restart`, `off` también están soportados

### ¿Cómo puedo activar la búsqueda y búsqueda web

`web_fetch` funciona sin una clave API. `web_search` requiere una clave de búsqueda de Brave API
. **Recomendado:** ejecuta `openclaw configure --section web` para almacenarlo en
`tools.web.search.apiKey`. alternativo de entorno: establezca `BRAVE_API_KEY` para el proceso
Gateway.

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE",
        resultados máximos: 5,
      },
      hetch: {
        enabled: true,
      },
    },
  },
}
```

Notas:

- Si utiliza listas permitidas, agregue `web_search`/`web_fetch` o `group:web`.
- `web_fetch` está habilitado de forma predeterminada (a menos que se deshabilite explícitamente).
- Daemons read env vars from `~/.openclaw/.env` (or the service environment).

Documentación: [Herramientas web](/tools/web).

### ¿Cómo puedo ejecutar una pasarela central con trabajadores especializados a través de dispositivos

El patrón común es **una pasarela** (por ejemplo, Raspberry Pi) más **nodos** y **agentes**:

- **Gateway (central):** posee canales (Signal/WhatsApp), enrutamiento y sesiones.
- **Nodos (devices):** Macs/iOS/Android conectan como periféricos y exponen herramientas locales (`system.run`, `canvas`, `camera`).
- **Agentes (trabajadores):** separados brains/espacios de trabajo para roles especiales (por ejemplo, "Hetzner ops", "Datos personales").
- **Subagentes:** el fondo de aparición de un agente principal cuando quieres paralelismo.
- **TUI:** conéctate a la pasarela y cambia de agentes/sesiones.

Docs: [Nodes](/nodes), [Acceso remoto](/gateway/remote), [Enrutamiento multiagente](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### Puede el navegador OpenClaw correr sin cabeza

Sí. Es una opción de configuración:

```json5
{
  browser: { headless: true },
  agents: {
    defaults: {
      sandbox: { browser: { headless: true } },
    },
  },
}
```

Por defecto es `false` (headful). Sin cabeza es más probable que desencadene comprobaciones anti-bot en algunos sitios. Ver [Browser](/tools/browser).

Headless utiliza el **mismo motor de Chromium** y funciona para la mayoría de la automatización (formas, clics, scraping, logins). Las principales diferencias:

- No hay ninguna ventana visible del navegador (use capturas de pantalla si necesita visuales).
- Algunos sitios son más estrictos sobre la automatización en modo sin cabeza (CAPTCHAs, anti-bot).
  Por ejemplo, X/Twitter a menudo bloquea las sesiones sin cabeza.

### Cómo uso Brave para el control del navegador

Establece `browser.executablePath` en tu binario Brave (o cualquier navegador basado en Chromium) y reinicia la puerta de enlace.
Ver los ejemplos de configuración completa en [Browser](/tools/browser#use-brave-or-another-chromium-based-browser).

## Pasarelas y nodos remotos

### Cómo se propagan los comandos entre Telegram la puerta de enlace y los nodos

Los mensajes de Telegram son manejados por la **pasarela**. La puerta de enlace ejecuta el agente y
sólo entonces llama a los nodos a través del **Gateway WebSocket** cuando se necesita una herramienta de nodo:

Telegram → Gateway → Agente → `node.*` → Node → Gateway → Telegram

Los nodos no ven tráfico de proveedores entrantes; sólo reciben llamadas RPC de nodo.

### ¿Cómo puede mi agente acceder a mi equipo si el Gateway está alojado de forma remota?

Respuesta corta: **emparejar tu computadora como un nodo**. La puerta de enlace se ejecuta en otro lugar, pero puede
llamar a herramientas `node.*` (pantalla, cámara, sistema) en su máquina local a través del WebSocket de Gateway.

Configuración típica:

1. Ejecute el Gateway en el host siempre encendido (servidor VPS/casa).
2. Ponga la anfitriona de la pasarela + su computadora en la misma tailnet.
3. Asegúrese de que la pasarela WS es accesible (enlace de tailnet o túnel SSH).
4. Abre la aplicación macOS localmente y conéctate en modo **Remoto a través de SSH** (o tailnet directo)
   para que pueda registrarse como nodo.
5. Aprobar el nodo en la puerta de enlace:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

No se requiere un puente TCP separado; los nodos se conectan sobre el WebSocket Gateway.

Recordatorio de seguridad: emparejar un nodo macOS permite `system.run` en esa máquina. Empareja solo dispositivos en los que confíes y revisa [Security](/gateway/security).

Docs: [Nodes](/nodes), [Protocolo de puerta de enlace](/gateway/protocol), [modo remoto macOS](/platforms/mac/remote), [Security](/gateway/security).

### La escala de escape está conectada, pero no obtengo respuestas que ahora

Compruebe lo básico:

- Gateway se está ejecutando: `openclaw gateway status`
- Salud de la puerta de enlace: `openclaw status`
- Salud del canal: `estatus de canales de openclaw`

Luego verifique la autenticación y el enrutamiento:

- Si utilizas la escala de envergadura, asegúrate de que `gateway.auth.allow scale` esté configurado correctamente.
- Si se conecta a través del túnel SSH, confirmar que el túnel local está arriba y apunta al puerto derecho.
- Confirme sus listas de permisos (DM o grupo) incluyen su cuenta.

Docs: [Tailscale](/gateway/tailscale), [Acceso remoto](/gateway/remote), [Channels](/channels).

### Puedes dos instancias OpenClaw hablar entre sí con VPS local

Sí. No existe un puente integrado de "bot a bot", pero puedes configurarlo de algunas formas fiables:

**Simplemente:** usa un canal de chat normal que ambos bots puedan acceder (Telegram/Slack/WhatsApp).
Haga que Bot A envíe un mensaje a Bot B, luego deje que Bot B responda como de costumbre.

**Puente CLI (genérico):** ejecuta un script que llama al otro Gateway con
`openclaw agent --message ... --deliver`, apunta a un chat donde el otro bot
escucha. Si un bot está en una VPN remota, apunta tu CLI a esa puerta de enlace remota
a través de escala SSH/volátil (ver [Acceso remoto](/gateway/remote)).

Patrón de ejemplo (ejecutado desde una máquina que puede alcanzar la puerta de enlace de destino):

```bash
openclaw agent --message "Hola desde el bot local" --deliver --channel telegram --reply-to <chat-id>
```

Consejo: añade un guardrail para que los dos bots no bucle sin fin (mencionando solo las listas permitidas
de canal, o una regla de "no responder a los mensajes del bot").

Docs: [Acceso remoto](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send).

### Necesito VPN separadas para múltiples agentes

No. Una pasarela puede alojar múltiples agentes, cada uno con su propio espacio de trabajo, los valores predeterminados del modelo,
y enrutamiento. Esa es la configuración normal y es mucho más barata y simple que ejecutar
un VPS por agente.

Utilice VPN separadas solo cuando necesite aislamiento duro (límites de seguridad) o muy
configuraciones diferentes que no desea compartir. De lo contrario, mantén una pasarela y
usar múltiples agentes o subagentes.

### ¿Hay un beneficio para usar un nodo en mi portátil personal en lugar de SSH desde un VPS

Sí - los nodos son la forma de primera clase de llegar a tu portátil desde una puerta de enlace remota, y ellos
desbloquean más que el acceso al intérprete. La puerta de enlace se ejecuta en macOS (Windows a través de WSL2) y es
ligero (una caja pequeña VPS o Raspberry Pi-class boxe; 4 GB de RAM es abundante), por lo que una configuración común
es un host siempre encendido más tu portátil como un nodo.

- **No se requiere SSH entrante.** Los nodos se conectan con el WebSocket de Gateway y utilizan el emparejamiento de dispositivos.
- **Controles de ejecución más seguros.** `system.run` está bloqueado por listas/aprobaciones de node en ese portátil.
- **Más herramientas de dispositivo.** Los nodos exponen `canvas`, `camera` y `screen` además de `system.run`.
- \*\*Automatización local del navegador. \* Mantener el Gateway en una VPS, pero ejecuta Chrome localmente y transfiere el control
  con la extensión Chrome + un host de nodo en la computadora portátil.

SSH está bien para el acceso ad-hoc al intérprete, pero los nodos son más simples para los flujos de trabajo de los agentes en curso y
la automatización de dispositivos.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Chrome extension](/tools/chrome-extension).

### Debería instalar en un segundo portátil o simplemente añadir un nodo

Si solo necesitas **herramientas locales** (screen/camera/exec) en el segundo portátil, agrégalo como un **nodo**
. Esto mantiene un único Gateway y evita la configuración duplicada. Las herramientas de nodos locales son
actualmente solo macOS, pero planeamos extenderlas a otros sistemas operativos.

Instala un segundo Gateway sólo cuando necesites **aislamiento duro** o dos bots completamente separados.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Múltiples pasarelas](/gateway/multiple-gateways).

### Los nodos ejecutan un servicio de gateway

No. Solo debe ejecutarse **una pasarela** por host a menos que ejecutes perfiles aislados intencionalmente (ver [Múltiples pasarelas](/gateway/multiple-gateways)). Los nodos son periféricos que conectan
a la puerta de enlace (nodos iOS/Android, o el "modo de nodo" de macOS en la aplicación de la barra de menú). Para hosts
y control CLI sin encabezados, vea [Node host CLI](/cli/node).

Se requiere un reinicio completo para los cambios `gateway`, `discovery`, y `canvasHost`.

### Hay una forma RPC API para aplicar la configuración

Sí. `config.apply` valida + escribe la configuración completa y reinicia el Gateway como parte de la operación.

### configapply borrado mi configuración ¿Cómo puedo recuperarme y evitar esto

`config.apply` reemplaza la **configuración completa**. Si envías un objeto parcial, todo lo demás se elimina.

Recuperar:

- Restaurar desde una copia de seguridad (git o un `~/.openclaw/openclaw.json`).
- Si no tienes copia de seguridad, vuelve a ejecutar `openclaw doctor` y reconfigura canales/modelos.
- Si esto era inesperado, archive un error e incluya su última configuración conocida o cualquier copia de seguridad.
- Un agente de codificación local a menudo puede reconstruir una configuración de trabajo a partir de registros o historial.

Evitarlo:

- Usa `openclaw config set` para pequeños cambios.
- Usa `openclaw configure` para ediciones interactivas.

Docs: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

### Qué es una configuración mínima para una primera instalación

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Esto establece tu espacio de trabajo y restringe quién puede activar el bot.

### ¿Cómo establezco escala en un VPS y me conecto desde mi Mac

Pasos mínimos:

1. **Instalar + iniciar sesión en la VPS**

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. **Instala + inicia sesión en tu Mac**
   - Utiliza la aplicación de escala e inicia sesión en la misma red.

3. **Habilitar MagicDNS (recomendado)**
   - En la consola de administración de escala alta, habilite MagicDNS para que el VPS tenga un nombre estable.

4. **Usa el nombre de host tailnet**
   - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - Portal WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

Si desea que la interfaz de control sin SSH, utilice el menú desplegable en la VPS:

```bash
openclaw gateway --tailscale serve
```

Esto mantiene la pasarela enlazada a bucle y expone HTTPS a escala alta. Ver [Tailscale](/gateway/tailscale).

### ¿Cómo puedo conectar un nodo Mac a una remota escala de Gateway Serve

Serve expone la **interfaz de control Gateway + WS**. Los nodos se conectan sobre el mismo punto final de Gateway WS.

Configuración recomendada:

1. **Asegúrate de que el VPS + Mac estén en la misma tailnet**.
2. **Usa la aplicación macOS en modo remoto** (SSH objetivo puede ser el nombre de host tailnet).
   La aplicación túnel el el puerto Gateway y se conectará como un nodo.
3. **Aprobar el nodo** en la puerta de enlace:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Docs: [Protocolo de puerta de enlace](/gateway/protocol), [Discovery](/gateway/discovery), [modo remoto macOS](/platforms/mac/remote).

## Carga de Env vars y .env

### ¿Cómo carga OpenClaw las variables de entorno

OpenClaw lee variables de entorno del proceso padre (shell, launchd/systemd, CI, etc.) y cargas adicionales:

- `.env` desde el directorio de trabajo actual
- un respaldo global `.env` desde `~/.openclaw/.env` (también conocido como `$OPENCLAW_STATE_DIR/.env`)

Ninguno de los archivos `.env` sobrescribe variables de entorno existentes.

También puede definir variables env en línea en la configuración (aplicado sólo si falta en el proceso env):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

Vea [/environment](/help/environment) para la precedencia y las fuentes completas.

### Empecé la puerta de enlace a través del servicio y mi env varas desapareció Lo que ahora

Dos correcciones comunes:

1. Pon las claves faltantes en `~/.openclaw/.env` así que son recogidas incluso cuando el servicio no hereda tu shell env.
2. Habilitar importación de shell (conveniencia opt-in):

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Esto ejecuta su shell de inicio de sesión e importa sólo las claves esperadas que faltan (nunca se anulan). Equivalentes de var de Env:
`OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

### Establezco COPILOTGITHUBTOKEN pero el estado de los modelos muestra Shell env apagado por qué

`openclaw models status` informa de si **shell env import** está habilitado. "Shell env: off"
**no** significa que faltan tus vars env - solo significa que OpenClaw no cargará
tu shell de inicio de sesión automáticamente.

Si el Gateway se ejecuta como un servicio (launchd/systemd), no heredará su entorno de shell
. Corregir haciendo uno de estos:

1. Pon el token en `~/.openclaw/.env`:

   ```
   COPILOT_GITHUB_TOKEN=...
   ```

2. O habilite la importación de shell (`env.shellEnv.enabled: true`).

3. O añádelo a tu bloque `env` de configuración (aplica sólo si falta).

Luego reinicie la pasarela y vuelva a comprobar:

```bash
openclaw models status
```

Los tokens de Copilot se leen de `COPILOT_GITHUB_TOKEN` (también `GH_TOKEN` / `GITHUB_TOKEN`).
Ver [/concepts/model-providers](/concepts/model-providers) y [/environment](/help/environment).

## Sesiones y múltiples chats

### Cómo comienzo una conversación nueva

Envía `/new` o `/reset` como un mensaje independiente. Ver [Gestión de la sesión](/concepts/session).

### Reiniciar sesiones automáticamente si nunca envío nuevas

Sí. Las sesiones expiran después de `session.idleMinutes` (por defecto **60**). El mensaje **siguiente**
inicia un nuevo id de sesión para esa clave de chat. Esto no elimina transcripciones* solo inicia una nueva sesión.

```json5
{
  sesión: {
    idleMinutes: 240,
  },
}
```

### Hay una manera de crear un equipo de instancias OpenClaw de un CEO y muchos agentes

Sí, a través de **enrutamiento multiagente** y **subagentes**. Puedes crear un coordinator
agente y varios agentes de trabajadores con sus propios espacios de trabajo y modelos.

Dicho esto, es mejor verlo como un **experimento divertido**. Es un token pesado y a menudo
menos eficiente que usar un bot con sesiones separadas. El modelo típico con el que visión
es un bot con el que hablas, con diferentes sesiones para el trabajo paralelo. Que el bot
también puede generar subagentes cuando sea necesario.

Docs: [Enrutamiento multi-agente](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agentes CLI](/cli/agents).

### ¿Por qué el contexto se truncó la mitad de la tarea ¿Cómo lo prevengo

El contexto de la sesión está limitado por la ventana del modelo. Largos chats, grandes salidas de herramientas o muchos archivos
pueden disparar compacción o truncación.

Lo que ayuda:

- Pida al bot que resuma el estado actual y lo escriba en un archivo.
- Usa `/compact` antes de tareas largas, y `/new` al cambiar temas.
- Mantener un contexto importante en el área de trabajo y pedir al bot que lo lea de nuevo.
- Utilice subagentes para el trabajo largo o paralelo para que el chat principal permanezca más pequeño.
- Escoja un modelo con una ventana contextual más grande si esto sucede a menudo.

### ¿Cómo reinicio completamente OpenClaw pero mantenlo instalado

Usar el comando de reinicio:

```bash
openclaw reset
```

Reinicio completo no interactivo:

```bash
openclaw reset --scope full --yes --non-interactive
```

Luego vuelva a ejecutar a bordo:

```bash
openclaw onboard --install-daemon
```

Notas:

- El asistente de incorporación también ofrece **Reiniciar** si ve una configuración existente. Ver [Wizard](/start/wizard).
- Si usaste perfiles (`--profile` / `OPENCLAW_PROFILE`), reinicia cada directorio de estado (por defecto son `~/.openclaw-<profile>`).
- Dev reset: `openclaw gateway --dev --reset` (sólo dev; wipes dev config + credenciales + sesiones + espacio de trabajo).

### Estoy obteniendo errores de contexto demasiado grandes como reinicio o compacto

Use una de estas opciones:

- **Compacto** (mantiene la conversación pero resume giros antiguos):

  ```
  /compacto
  ```

  o `/compact <instructions>` para guiar el resumen.

- **Reiniciar** (ID de sesión fresca para la misma clave de chat):

  ```
  /new
  /reset
  ```

Si sigue sucediendo:

- Activa o sintoniza **la poda de sesión** (`agents.defaults.contextPruning`) para recortar la antigua salida de herramientas.
- Utilice un modelo con una ventana contextual más grande.

Docs: [Compaction](/concepts/compaction), [Limpieza de la sesión](/concepts/session-pruning), [Gestión de la sesión](/concepts/session).

### ¿Por qué veo la solicitud LLM rechazada por mensajesNcontentXtooluseinput Campo requerido

Este es un error de validación del proveedor: el modelo emitió un bloque `tool_use` sin la `input`
requerida. Normalmente significa que el historial de sesiones es obsoleto o corrupto (a menudo después de largos hilos
o de un cambio de herramientas/esquema).

Corregir: iniciar una sesión nueva con `/new` (mensaje independiente).

### ¿Por qué estoy recibiendo mensajes con latidos cardiacos cada 30 minutos

Heartbeats se ejecutan por defecto cada **30m**. Ajustar o desactivarlos:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        cada: "2h", // o "0m" para desactivar
      },
    },
  },
}
```

Si `HEARTBEAT.md` existe pero está efectivamente vacío (solo líneas en blanco y encabezados markdown como `# Heading`), OpenClaw omite la ejecución del heartbeat para ahorrar llamadas a la API.
Si el archivo falta, el heartbeat se ejecuta y el modelo decide qué hacer.

Por agente sobreescribe usa `agents.list[].heartbeat`. Docs: [Heartbeat](/gateway/heartbeat).

### Necesito añadir una cuenta de bot a un grupo de WhatsApp

No. OpenClaw funciona en **tu propia cuenta**, así que si estás en el grupo, OpenClaw puede verla.
Por defecto, las respuestas de grupo están bloqueadas hasta que permitas a los remitentes (`groupPolicy: "allowlist"`).

Si solo quieres que **tú** pueda activar respuestas de grupo:

```json5
{
  canales: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

### ¿Cómo obtengo el JID de un grupo de WhatsApp

Opción 1 (más rápido): registros de cola y enviar un mensaje de prueba en el grupo:

```bash
logs de openclaw --follow --json
```

Busca `chatId` (o `from`) que termine en `@g.us`, como:
`1234567890-1234567890@g.us`.

Opción 2 (si ya está configurado/permitido): listar grupos de configuración:

```bash
lista de grupos de directorio de openclaw --channel whatsapp
```

Docs: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

### ¿Por qué no responde OpenClaw en un grupo

Dos causas comunes:

- La compuerta de menciones está activada (por defecto). Debes @mention el bot (o coincidir con `mentionPatterns`).
- Has configurado `channels.whatsapp.groups` sin `"*"` y el grupo no está permitido.

Ver [Groups](/channels/groups) y [Mensajes grupales] (/channels/group-messages).

### Hacer grupos compartir contexto con DMs

Los chats directos colapsan a la sesión principal por defecto. Los grupos/canales tienen sus propias claves de sesión, y los temas de Telegram / hilos de Discord son sesiones separadas. Ver [Groups](/channels/groups) y [Mensajes grupales] (/channels/group-messages).

### Cuántas áreas de trabajo y agentes puedo crear

Sin límites duros. Decenas (incluso centenas) están bien, pero cuidado:

- **Crecimiento del disco:** sesiones + transcripciones en vivo bajo `~/.openclaw/agents/<agentId>/sessions/`.
- **Coste del token:** más agentes significa un uso más simultáneo del modelo.
- **Ops overhead:** por agente perfiles de autor, espacios de trabajo y enrutamiento de canales.

Consejos:

- Mantén un espacio de trabajo **activo** por agente (`agents.defaults.workspace`).
- Limpiar sesiones antiguas (borrar JSONL o almacenar entradas) si el disco crece.
- Usa `openclaw doctor` para detectar espacios de trabajo perdidos y desajustes en el perfil.

### ¿Puedo ejecutar varios bots o chats al mismo tiempo Slack y cómo debería configurarlo

Sí. Usa **Multi-Agent Routing** para ejecutar múltiples agentes aislados y enrutar mensajes entrantes por canal/cuenta/par. Slack es soportado como un canal y puede estar vinculado a agentes específicos.

El acceso al navegador es potente, pero no es "hacer todo lo que un humano puede": los sistemas anti‑bot, los CAPTCHAs y la MFA aún pueden bloquear la automatización. Para el control más confiable del navegador, utilice el relé de extensión de Chrome
en la máquina que ejecuta el navegador (y mantenga el Gateway en cualquier lugar).

Configuración de la mejor práctica:

- Anfitrión de Gateway siempre activo (VPS/Mac mini).
- Un agente por rol (enlaces).
- Canal(es) Slack vinculados a esos agentes.
- Navegador local vía relé de extensión (o un nodo) cuando sea necesario.

Docs: [Enrutamiento Multi-Agentes](/concepts/multi-agent), [Slack](/channels/slack),
[Browser](/tools/browser), [Extensión Chrome](/tools/chrome-extension), [Nodes](/nodes).

## Modelos: predeterminados, selección, alias, cambio

### ¿Cuál es el modelo por defecto

El modelo por defecto de OpenClaw es lo que usted establezca:

```
agents.defaults.model.primary
```

Los modelos son referenciados como `provider/model` (ejemplo: `anthropic/claude-op)[video] 4-6`). Si omites el proveedor, OpenClaw asume actualmente `anthropic` como un respaldo de desaprobación temporal - pero deberías establecer **explícitamente** `provider/model`.

### Qué modelo recomiendas

**Predeterminado recomendado:** `anthropic/claude-opus-4-6`.
**Buena alternativa:** `anthropic/claude-sonnet-4-5`.
**Fiable (menos carácter):** `openai/gpt-5.2` - casi tan bueno como Opus, sólo menos personalidad.
**Budget:** `zai/glm-4.7`.

MiniMax M2.1 tiene sus propios documentos: [MiniMax](/providers/minimax) y
[modelos locales](/gateway/local-models).

Regla de miniatura: usa el **mejor modelo que puedas permitir** para el trabajo de alto nivel y un modelo
más barato para el chat de rutina o los resúmenes. Puedes enrutar modelos por agente y usar subagentes a
paralelizar tareas largas (cada subagente consume tokens). Ver [Models](/concepts/models) y
[Sub-agents](/tools/subagents).

Advertencia fuerte: los modelos más débiles y sobrecuantificados son más vulnerables a la inyección
y al comportamiento inseguro. Ver [Security](/gateway/security).

Más contexto: [Models](/concepts/models).

### Puedo usar modelos autoalojados llamacpp vLM Ollama

Sí. Si tu servidor local expone una API compatible con OpenAI, puedes apuntar un proveedor personalizado a ella. Ollama está soportado directamente y es el camino más fácil.

Nota de seguridad: los modelos pequeños o fuertemente cuantizados son más vulnerables a la inyección
. Recomendamos fuertemente **modelos grandes** para cualquier bot que pueda usar herramientas.
Si todavía quieres modelos pequeños, activa el sandboxing y listas de permisos de herramientas estrictas.

Docs: [Ollama](/providers/ollama), [Modelos locales](/gateway/local-models),
[Proveedores de modelos](/concepts/model-providers), [Security](/gateway/security),
[Sandboxing](/gateway/sandboxing).

### ¿Cómo puedo cambiar de modelo sin borrar mi configuración

Use **comandos de modelo** o edite sólo los campos **modelo**. Evitar reemplazos de configuración completa.

Opciones seguras:

- `/model` en el chat (rápido, por sesión)
- `openclaw models set ...` (actualizaciones sólo configuración del modelo)
- `openclaw configure --section model` (interactivo)
- edita `agents.defaults.model` en `~/.openclaw/openclaw.json`

Evita `config.apply` con un objeto parcial a menos que pretendas reemplazar toda la configuración.
Si has sobreescrito la configuración, restaura desde la copia de seguridad o vuelve a ejecutar `openclaw doctor` para reparar.

Docs: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

### ¿Qué utilizan OpenClaw, Flawd y Krill para modelos

- **OpenClaw + Flawd:** Opus antropico (`antropic/claude-op✫ 4-6`) - ver [Anthropic](/providers/anthropic).
- **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - see [MiniMax](/providers/minimax).

### ¿Cómo puedo cambiar los modelos en marcha sin reiniciar

Usa el comando `/model` como un mensaje independiente:

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

Puede listar modelos disponibles con `/model`, `/model list`, o `/model status`.

`/model` (y `/model list`) muestra un selector compacto y numerado. Seleccionar por número:

```
/modelo 3
```

También puede forzar un perfil de autenticación específico para el proveedor (por sesión):

```
/model opus@anthropic:default
/model opus@anthropic:work
```

Consejo: `/model status` muestra qué agente está activo, qué archivo `auth-profiles.json` está siendo usado, y qué perfil de autenticación será probado a continuación.
También muestra el endpoint del proveedor configurado (`baseUrl`) y el modo API (`api`) cuando está disponible.

**¿Cómo desanclo un perfil que establecí con el perfil**

Re-ejecuta `/model` **sin** el sufijo `@profile`:

```
/model anthropic/claude-op✫ 4-6
```

Si quieres volver al valor por defecto, selecciónalo de `/model` (o envía `/model <default provider/model>`).
Usa `/model status` para confirmar qué perfil de autenticación está activo.

### ¿Puedo usar GPT 5.2 para tareas diarias y Codex 5.3 para la codificación

Sí. Establecer uno como predeterminado y cambiar según sea necesario:

- **Interruptor rápido (por sesión):** `/model gpt-5.2` para tareas diarias, `/model gpt-5.3-codex` para la codificación.
- **Por defecto + switch:** establece `agents.defaults.model.primary` a `openai/gpt-5.2`, luego cambia a `openai-codex/gpt-5.3-codex` al codificar (o al revés).
- **Subagentes:** enrutar tareas de codificación a subagentes con un modelo predeterminado diferente.

Ver [Models](/concepts/models) y [Slash commands](/tools/slash-commands).

### ¿Por qué veo Modelo no está permitido y luego no hay respuesta

Si se establece `agents.defaults.models`, se convierte en la **lista de permitidos** para `/model` y cualquier sobrescritura de sesión. Al elegir un modelo que no está en esa lista regresa:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Ese error se devuelve **en vez de** una respuesta normal. Corrección: añade el modelo a
`agents.defaults.models`, elimina la lista permitida, o elige un modelo de `/model list`.

### ¿Por qué veo modelo desconocido minimaxMiniMaxM21

Esto significa que el **proveedor no está configurado** (no se ha encontrado el perfil de proveedor MiniMax o Auth
), por lo que el modelo no puede ser resuelto. Una solución para esta detección es
en **2026.1.12** (no publicada en el momento de escribir).

Fijar lista de verificación:

1. Actualice a **2026.1.12** (o ejecute desde la fuente `main`), luego reinicie la puerta de enlace.
2. Asegúrese de que MiniMax está configurado (asistente o JSON), o que existe una clave API MiniMax
   en los perfiles de env/auth para que el proveedor pueda ser inyectado.
3. Usa el id del modelo exacto (sensible a mayúsculas/minúsculas): `minimax/MiniMax-M2.1` o
   `minimax/MiniMax-M2.1-lightning`.
4. Run:

   ```bash
   openclaw models list
   ```

   y escoja de la lista (o `/model list` en el chat).

Ver [MiniMax](/providers/minimax) y [Models](/concepts/models).

### ¿Puedo usar MiniMax como mi predeterminado y OpenAI para tareas complejas

Sí. Use **MiniMax como predeterminado** y conmuta modelos **por sesión** cuando sea necesario.
Fallbacks son para **errores**, no para "tareas duras", así que usa `/model` o un agente separado.

**Opción A: cambio por sesión**

```json5
{
  env: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-... },
  agents: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2. " },
      modelos: {
        "minimax/MiniMax-M2. ": { alias: "minimax" },
        "openai/gpt-5. ": { alias: "gpt" },
      },
    },
  },
}
```

Luego:

```
/model gpt
```

**Opción B: agentes separados**

- Agente un predeterminado: MiniMax
- Agente B por defecto: OpenAI
- Ruta por agente o usa `/agent` para cambiar

Docs: [Models](/concepts/models), [Ruta Multiagente ](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### Son accesos directos integrados por opus sonnet

Sí. OpenClaw viene unos cuantos atajos por defecto (solo se aplica cuando el modelo existe en `agents.defaults.models`):

- `opus` → `antropic/claude-op→ 4-6`
- `sonnet` → `antropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

Si estableces tu propio alias con el mismo nombre, tu valor gana.

### ¿Cómo defino el alias de los atajos de modelo

Los alias vienen de `agents.defaults.models.<modelId>.alias`. Ejemplo:

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opichard 4-6" },
      modelos: {
        "anthropic/claude-opichard 4-6": { alias: "opus" },
        "antropic/claude-sonnet-4-5": { alias: "sonnet" },
        "antropic/claude-haiku-4-5": { alias: "haiku" },
      },
    },
  },
}
```

Luego `/model sonnet` (o `/<alias>` cuando es soportado) resuelve el ID del modelo.

### ¿Cómo puedo añadir modelos de otros proveedores como OpenRouter o ZAI

OpenRouter (pay-per-token; muchos modelos):

```json5
{
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      modelos: { "openrouter/anthropic/claude-sonnet-4-5": {} },
    },
  },
  env: { OPENROUTER_API_KEY: "sk-or-. ." },
}
```

Z.AI (modelos GLM):

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4. " },
      modelos: { "zai/glm-4. ": {} },
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

Si hace referencia a un proveedor/modelo pero falta la clave de proveedor requerida, obtendrá un error de autenticación de tiempo de ejecución (e. . `No se ha encontrado una clave API para el proveedor "zai"`).

**No se encontró ninguna clave API para el proveedor después de añadir un nuevo agente**

Esto generalmente significa que el **nuevo agente** tiene una tienda de autenticación vacía. La autenticación es por agente y
almacenada en:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Opciones de solución:

- Ejecuta `openclaw agents add <id>` y configure la autenticación durante el asistente.
- O copia `auth-profiles.json` del agente principal `agentDir` en el nuevo agente `agentDir`.

**no** reuse `agentDir` a través de los agentes; causa colisiones de autenticidad/sesión.

## Modelo de tolerancia contra fallos y "Todos los modelos fallidos"

### Cómo funciona la tolerancia contra fallos

La falla ocurre en dos etapas:

1. **Rotación de perfil de autorización** dentro del mismo proveedor.
2. **Fallback de modelos** al siguiente modelo en `agents.defaults.model.fallbacks`.

Los tiempos de enfriamiento se aplican a perfiles fallidos (retroceso exponencial), por lo que OpenClaw puede seguir respondiendo incluso cuando un proveedor está limitado o temporalmente fallando.

### Qué significa este error

```
No se encontraron credenciales para el perfil "anthropic:default"
```

Significa que el sistema intentó usar el ID de perfil de autenticación `anthropic:default`, pero no pudo encontrar credenciales para él en el almacenamiento de autenticación esperado.

### Corregir lista de verificación para No se encontraron credenciales para el perfil antroppicdefault

- **Confirma dónde viven los perfiles de autor** (nuevas vs rutas heredadas)
  - Actual: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - Legancia: `~/.openclaw/agent/*` (migrado por `openclaw doctor`)
- \*\*Confirma que la variable env está cargada por la pasarela \*\*
  - Si establece `ANTHROPIC_API_KEY` en su shell pero ejecuta el Gateway vía systemd/launchd, no puede heredarlo. Colócalo en `~/.openclaw/.env` o habilite `env.shellEnv`.
- **Asegúrate de que estás editando el agente correcto**
  - Configuraciones multiagente significan que puede haber múltiples archivos `auth-profiles.json`.
- **Estado del modelo/autenticación de comprobación de anidades**
  - Usa `openclaw models status` para ver los modelos configurados y si los proveedores están autenticados.

**Corregir la lista de verificación para No se encontraron credenciales para el perfil antropica**

Esto significa que la ejecución está anclada a un perfil de autenticación Antrópico, pero el Gateway
no puede encontrarlo en su tienda de autenticación.

- **Usa un token de configuración**
  - Ejecuta `claude setup-token`, luego pégalo con `openclaw models auth setup-token --provider anthropic`.
  - Si el token fue creado en otra máquina, use `openclaw models auth paste-token --provider anthropic`.

- **Si quieres usar una clave API en su lugar**
  - Pon `ANTHROPIC_API_KEY` en `~/.openclaw/.env` en el **host de puerta de enlace**.
  - Limpia cualquier orden fijada que obligue a perder un perfil:

    ```bash
    modelos de openclaw auth order clear --provider anthropic
    ```

- **Confirma que estás ejecutando comandos en el host del concentrador**
  - En modo remoto, los perfiles de autenticación viven en la máquina puerta de enlace, no en su portátil.

### ¿Por qué lo hizo también probar Google Gemini y fallar

Si la configuración del modelo incluye Google Gemini como un respaldo (o cambiaste a un abreviatura de Gemini), OpenClaw lo intentará durante la reserva del modelo. Si no has configurado las credenciales de Google, verás `Ninguna clave API encontrada para el proveedor "google"`.

Corregir: proporcionar la autenticación de Google, o eliminar/evitar los modelos de Google en `agents.defaults.model.fallbacks` / alias, por lo que fallback no enruta.

\*\*Solicitud LLM rechazada de mensaje pensando que la firma de google requería antigravedad. \*\*

Causa: el historial de sesiones contiene **bloques de pensamiento sin firmas** (a menudo de
un flujo abortado/parcial). Google Antigravity requiere firmas para pensar bloques.

Corregir: OpenClaw ahora quita bloques pensantes sin firmar para Google Antigravity Claude. Si todavía aparece, inicia una **nueva sesión** o desactiva `/thinking off` para ese agente.

## Perfiles de autor: qué son y cómo gestionarlos

Relacionado: [/concepts/oauth](/concepts/oauth) (Flujos de OAuth, almacenamiento de tokens, patrones de varias cuentas)

### Qué es un perfil de autenticación

Un perfil de autenticación es un registro de credenciales con nombre (OAuth o API key) vinculado a un proveedor. Perfiles vivos en:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### Qué son los IDs de perfil típicos

OpenClaw utiliza IDs de prefijo de proveedor como:

- `anthropic:default` (común cuando no existe identidad de correo electrónico)
- `antropía:<email>` para identidades de OAuth
- IDs personalizados que elijas (p. ej., `anthropic:work`)

### ¿Puedo controlar qué perfil de autenticación se prueba primero

Sí. Configuración soporta metadatos opcionales para perfiles y un pedido por proveedor (`auth.order.<provider>`). Esto **no** almacena secretos; asigna IDs al proveedor/modo y establece orden de rotación.

OpenClaw puede saltar temporalmente un perfil si se encuentra en un corto **tiempo de recarga** (límites de velocidad/timeouts/fallas de autenticidad) o un estado **deshabilitado** más largo (créditos de facturación/insuficiencia de la cuenta). Para inspeccionar esto, ejecuta `openclaw models status --json` y comprueba `auth.unusableProfiles`. Tuning: `auth.cooldowns.billingBackoffHours*`.

También puedes establecer una anulación de orden **por agent** (almacenada en el `auth-profiles.json`) de ese agente mediante la CLI:

```bash
# Por defecto el agente predeterminado configurado (omit --agent)
openclaw models auth order get --provider anthropic

# Bloquea la rotación a un solo perfil (solo prueba este)
openclaw models auth order set --provider anthropic:default

# O establece un pedido explícito (respaldo dentro del proveedor)
openclaw model auth order set --provider anthropic:work anthropic:default

# Borrar la anulación (caer de vuelta a la autenticación de configuración). rder / round-robin)
modelos de openclaw auth order clear --provider anthropic
```

Para apuntar a un agente específico:

```bash
modelo de openclaw auth order set --provider anthropic --agent main anthropic:default
```

### La clave OAuth vs API es la diferencia

OpenClaw soporta ambos:

- **OAuth** a menudo aprovecha el acceso a la suscripción (si es aplicable).
- Las **claves de API** usan facturación de pay-per-token.

El asistente soporta explícitamente Anthropic setup-token y OpenAI Codex OAuth y puede almacenar las claves API para usted.

## Puerta de enlace: puertos, "ya en ejecución" y modo remoto

### Qué puerto utiliza la puerta de enlace

`gateway.port` controla el único puerto multiplexado para WebSocket + HTTP (interfaz de control, ganchos, etc.).

Precedencia:

```
--port > OPENCLAW_GATEWAY_PORT > gateway.port > por defecto 18789
```

### ¿Por qué el estado de openclaw gateway dice Ejecutar tiempo pero la sonda RPC falló

Porque "corriendo" es la vista de **supervisor** (launchd/systemd/schtasks). La sonda RPC es el CLI que se conecta a la pasarela WebSocket y llama a `status`.

Usa `openclaw gateway status` y confía en estas líneas:

- `Destino de sonda:` (la URL que la sonda utiliza realmente)
- `Escuchando:` (lo que está realmente vinculado en el puerto)
- `Último error de puerta de enlace:` (causa raíz común cuando el proceso está vivo pero el puerto no está escuchando)

### ¿Por qué el estado de la pasarela de openclaw muestra el servicio Config cli y Config diferente

Estás editando un archivo de configuración mientras el servicio está ejecutando otro (a menudo un `--profile` / `OPENCLAW_STATE_DIR`).

Solución:

```bash
openclaw gateway install --force
```

Ejecute que desde el mismo `--profile` / entorno que desea que el servicio se utilice.

### ¿Qué significa otra instancia de gateway ya está escuchando

OpenClaw fuerza un bloqueo de ejecución enlazando el detector WebSocket inmediatamente al inicio (por defecto `ws://127.0.0.1:18789`). Si el enlace falla con `EADDRINUSE`, arroja `GatewayLockError` indicando que otra instancia ya está escuchando.

Corrección: detener la otra instancia, liberar el puerto, o ejecutar con `openclaw gateway --port <port>`.

### ¿Cómo ejecutar OpenClaw en cliente de modo remoto se conecta a un Gateway en otro lugar

Establece `gateway.mode: "remote"` y apunta a una URL remota de WebSocket, opcionalmente con un token/contraseña:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      password: "your-password",
    },
  },
}
```

Notas:

- `openclaw gateway` sólo se inicia cuando `gateway.mode` es `local` (o pasas la bandera overwrite).
- La aplicación macOS observa el archivo de configuración y cambia los modos en vivo cuando estos valores cambian.

### La interfaz de control dice no autorizado o sigue reconectando lo que ahora

Su puerta de enlace se está ejecutando con la autenticación habilitada (`gateway.auth.*`), pero la interfaz de usuario no está enviando el token / contraseña coincidente.

Datos (de código):

- La interfaz de control almacena el token en la clave de almacenamiento local del navegador `openclaw.control.settings.v1`.

Solución:

- Más rápido: `openclaw dashboard` (imprime + copia la URL del tablero, intenta abrir; muestra la pista SSH si no tiene cabeza).
- Si aún no tienes un token: `openclaw doctor --generate-gateway-token`.
- If remote, tunnel first: `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/`.
- Establece `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`) en el host de la puerta de enlace.
- En la configuración de la interfaz de Control, pegue el mismo token.
- ¿Aún atascado? Ejecuta `openclaw status --all` y sigue [Troubleshooting](/gateway/troubleshooting). Ver [Dashboard](/web/dashboard) para más detalles.

### Establezco red de enlace pero no puedo enlazar nada escucha

`tailnet` bind escoge una IP de escala de su interfaz de red (100.64.0.0/10). Si la máquina no está en escamas (o la interfaz está caída), no hay nada a lo que enlazar.

Solución:

- Iniciar escala en ese host (por lo que tiene una dirección 100.x), o
- Cambia a `gateway.bind: "loopback"` / `"lan"`.

Nota: `tailnet` es explícito. `auto` prepara loopback; usa `gateway.bind: "tailnet"` cuando quieres un enlace de sólo tailnet.

### ¿Puedo ejecutar múltiples pasarelas en el mismo host

Normalmente no hay - un Gateway puede ejecutar múltiples canales y agentes de mensajería. Usa múltiples pasarelas sólo cuando necesites redundancia (ej: robot de rescate) o aislamiento duro.

Sí, pero usted debe aislar:

- `OPENCLAW_CONFIG_PATH` (configuración por instancia)
- `OPENCLAW_STATE_DIR` (estado por instancia)
- `agents.defaults.workspace` (aislamiento del espacio de trabajo)
- `gateway.port` (puertos únicos)

Configuración rápida (recomendado):

- Usa `openclaw --profile <name> …` por instancia (auto-creates `~/.openclaw-<name>`).
- Establece un `gateway.port` único en cada configuración de perfil (o pasa `--port` para ejecuciones manuales).
- Install a per-profile service: `openclaw --profile <name> gateway install`.

Perfiles también sufijo nombres de servicio (`bot.molt.<profile>`; legado `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).
Guía completa: [Múltiples gateways](/gateway/multiple-gateways).

### ¿Qué significa el código 1008 de agitador de manos inválido

El Gateway es un **servidor WebSocke**, y espera que el primer mensaje a
sea un marco `connect`. Si recibe otra cosa, cierra la conexión
con **código 1008** (infracción de la política).

Causas comunes:

- Has abierto la URL **HTTP** en un navegador (`http://...`) en lugar de un cliente WS.
- Utilizaste el puerto o ruta incorrectos.
- Un proxy o túnel despojó cabeceras de autenticación o envió una petición no Gateway.

Correcciones rápidas:

1. Usa la URL WS: `ws://<host>:18789` (o `wss://...` if HTTPS).
2. No abra el puerto WS en una pestaña normal del navegador.
3. Si la autenticación está activada, incluya el token/password en el marco `connect`.

Si estás usando el CLI o TUI, la URL debería verse como:

```
openclaw tui --url ws://<host>:18789 --token <token>
```

Detalles del protocolo: [Protocolo del Gateway](/gateway/protocol).

## Registro y depuración

### Dónde están los registros

Registros de archivos (estructurados):

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Puede establecer una ruta estable a través de `logging.file`. El nivel de registro de archivos está controlado por `logging.level`. La verbosidad de la consola es controlada por `--verbose` y `logging.consoleLevel`.

Tela de registro más rápida:

```bash
openclaw logs --follow
```

Servicio/supervisor logs (cuando la puerta de enlace se ejecuta a través de launchd/systemd):

- macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` y `gateway.err.log` (por defecto: `~/.openclaw/logs/...`; los perfiles usan `~/.openclaw-<profile>/logs/...`)
- Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

Ver [Troubleshooting](/gateway/troubleshooting#log-locations) para más.

### ¿Cómo empiezo el servicio Gateway

Usar los ayudantes del concentrador:

```bash
estado de la puerta de enlace de openclaw
reinicio de la puerta de enlace
```

Si ejecuta la puerta de enlace manualmente, `openclaw gateway --force` puede reclamar el puerto. Consulte [Gateway](/gateway).

### Cerré mi terminal en Windows cómo reinicio OpenClaw

Hay **dos modos de instalación de Windows**:

**1) WSL2 (recomendado):** el Gateway se ejecuta dentro de Linux.

Abre PowerShell, introduce WSL, luego reinicia:

```powershell
wsl
openclaw gateway status
reinicio de openclaw gateway
```

Si nunca has instalado el servicio, inicia en primer plano:

```bash
openclaw gateway run
```

**2) Windows nativo (no recomendado):** la puerta de enlace se ejecuta directamente en Windows.

Abrir PowerShell y ejecutar:

```powershell
estado de la puerta de enlace de openclaw
reinicio de la puerta de enlace
```

Si lo ejecuta manualmente (sin servicio), use:

```powershell
openclaw gateway run
```

Docs: [Windows (WSL2)](/platforms/windows), [Gateway service runbook](/gateway).

### La puerta de enlace está arriba pero las respuestas nunca llegan Lo que debería comprobar

Comenzar con un barrido de salud rápido:

```bash
openclaw status
openclaw models status
openclaw channels status
openclaw logs --follow
```

Causas comunes:

- La autenticación del modelo no se cargó en el **host de la puerta de enlace** (compruebe `model status`).
- Emparejamiento de canales/lista permitida bloqueando respuestas (compruebe la configuración del canal + registros).
- WebChat/Panel de control está abierto sin el token correcto.

Si usted es remoto, confirme que la conexión túnel/escala está arriba y que el conector WebSocket
Gateway es alcanzable.

Docs: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Acceso remoto](/gateway/remote).

### Desconectado de la puerta de enlace no hay razón para lo que ahora

Esto generalmente significa que la interfaz de usuario perdió la conexión WebSocket. Verifique:

1. ¿Está funcionando la puerta de enlace? `openclaw gateway status`
2. ¿La pasarela está sana? `openclaw status`
3. ¿Tiene la IU el código correcto? `openclaw dashboard`
4. Si es remoto, ¿está el túnel/escala hacia arriba?

A continuación los registros de cola:

```bash
openclaw logs --follow
```

Docs: [Dashboard](/web/dashboard), [Acceso remoto](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

### Telegram setMyCommands falla con errores de red ¿Qué debo comprobar

Comenzar con registros y estado del canal:

```bash
estado de canales de openclaw
canales de openclaw logs --channel telegram
```

Si estás en un VPS o detrás de un proxy, confirma que HTTPS saliente está permitido y DNS funciona.
Si el Gateway es remoto, asegúrese de que está mirando los registros en el host Gateway.

Docs: [Telegram](/channels/telegram), [Solución de problemas del canal](/channels/troubleshooting).

### TUI no muestra salida ¿Qué debo comprobar

Primero confirme que el Gateway es accesible y el agente puede correr:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

En la interfaz de usuario, usa `/status` para ver el estado actual. Si esperas respuestas en un canal
de chat, asegúrate de que la entrega está activada (`/deliver on`).

Docs: [TUI](/web/tui), [Slash commands](/tools/slash-commands).

### ¿Cómo me detengo completamente entonces iniciar el Gateway

Si instaló el servicio:

```bash
puerta de enlace openclaw stop
inicio de la puerta de enlace openclaw
```

Esto detiene/inicia el **servicio supervisado** (launchd en macOS, systemd en Linux).
Usar esto cuando el Gateway se ejecuta en segundo plano como un daemon.

Si está corriendo en primer plano, pare con Ctrl-C, entonces:

```bash
openclaw gateway run
```

Docs: [Gateway service runbook](/gateway).

### Reiniciar la puerta de enlace de openclaw ELI5 vs puerta de enlace de openclaw

- `openclaw gateway restart`: reinicia el **servicio de fondo** (launchd/systemd).
- `puerta de enlace openclaw`: ejecuta la puerta de enlace **en el primer plano** para esta sesión de terminal.

Si instaló el servicio, utilice los comandos de gateway. Usa `pasarela de openclaw` cuando
quieres una sola ejecución.

### ¿Cuál es la forma más rápida de obtener más detalles cuando algo falle

Inicia el Gateway con `--verbose` para obtener más detalles de la consola. Luego inspeccione el archivo de registro para los errores de autenticación del canal, enrutamiento del modelo y RPC.

## Multimedia y archivos adjuntos

### Mi habilidad generó una imagen PDF pero no se envió nada

Los archivos adjuntos salientes del agente deben incluir una línea `MEDIA:<path-or-url>` (en su propia línea). Ver [Configuración del asistente de OpenClaw](/start/openclaw) y [Agente enviado](/tools/agent-send).

Envío de CLI:

```bash
mensaje de openclaw enviar --target +155550123 --message "Here you go" --media /path/to/file.png
```

Comprobar también:

- El canal de destino soporta medios salientes y no está bloqueado por listas permitidas.
- El archivo está dentro de los límites de tamaño del proveedor (las imágenes se redimensionan hasta máximo 2048px).

Ver [Images](/nodes/images).

## Control de seguridad y acceso

### Es seguro exponer OpenClaw a DMs entrantes

Trate a los DMs entrantes como entradas no confiables. Los valores por defecto están diseñados para reducir el riesgo:

- El comportamiento por defecto en los canales compatibles con DM está **emparejando**:
  - Los remitentes desconocidos reciben un código de emparejamiento; el bot no procesa su mensaje.
  - Aprobar con: `emparejamiento de openclaw aprobar <channel> <code>`
  - Las solicitudes pendientes tienen un límite de **3 por canal**; comprueba la `lista de emparejamiento de openclaw <channel>` si un código no llegó.
- Abrir DMs públicamente requiere opt-in explícito (`dmPolicy: "open"` y allowlist \`"\*").

Ejecuta `openclaw doctor` para las políticas de DM de riesgo superficial.

### Es la inyección rápida sólo una preocupación para los robots públicos

No. La inyección de prompt es sobre **contenido no confiable**, no sólo quién puede DM el bot.
Si su asistente lee contenido externo (búsqueda/obtención, páginas del navegador, correos electrónicos,
documentos, adjuntos, registros pegados) que el contenido puede incluir instrucciones que prueben
para secuestrar el modelo. Esto puede suceder incluso si **eres el único emisor**.

El mayor riesgo es cuando las herramientas están habilitadas: el modelo puede ser engañado en
exfiltrando el contexto o llamando a herramientas en tu nombre. Reduzca el radio de impacto mediante:

- usando un agente de "lector" de sólo lectura o de herramientas desactivadas para resumir contenido no confiable
- mantener desconectado `web_search` / `web_fetch` / `browser` para agentes habilitados por herramientas
- sandboxing y listas de herramientas estrictas

Detalles: [Security](/gateway/security).

### Mi bot debería tener su propia cuenta o número de teléfono de GitHub de correo electrónico

Sí, para la mayoría de las configuraciones. Aislar el bot con cuentas separadas y números de teléfono
reduce el radio de explosión si algo sale mal. Esto también facilita la rotación de credenciales
o la revocación del acceso sin afectar a sus cuentas personales.

Iniciar pequeño. Dar acceso solo a las herramientas y cuentas que realmente necesitas, y expandir
más adelante si es necesario.

Docs: [Security](/gateway/security), [Pairing](/channels/pairing).

### ¿Puedo darle autonomía sobre mis mensajes de texto y es tan seguro

**no** recomendamos la autonomía total sobre sus mensajes personales. El patrón más seguro es:

- Mantenga las DMs en **modo de emparejamiento** o en una lista de permitidos ajustada.
- Usa un **número o cuenta separada** si quieres que te envíe un mensaje en tu nombre.
- Deje que borre, luego **apruebe antes de enviar**.

Si quieres experimentar, hazlo en una cuenta dedicada y mantenerlo aislado. Ver
[Security](/gateway/security).

### ¿Puedo usar modelos más baratos para tareas personales de asistente

Sí, **si** el agente es sólo de chat y la entrada es de confianza. Los niveles más pequeños son
más susceptibles para el secuestro de instrucciones, así que evitarlos para los agentes con herramientas
o cuando lean contenido no confiable. Si debes usar un modelo más pequeño, bloquea las herramientas
y corre dentro de un sandbox. Ver [Security](/gateway/security).

### Corre el inicio en Telegram pero no conseguí un código de emparejamiento

Los códigos de emparejamiento se envían **sólo** cuando un remitente desconocido envía mensajes al bot y
`dmPolicy: "emparejamiento"` está habilitado. `/start` por sí mismo no genera un código.

Verificar solicitudes pendientes:

```bash
openclaw pairing list telegram
```

Si quieres acceso inmediato, deja la lista de tu identificador de remitente o establece `dmPolicy: "open"`
para esa cuenta.

### WhatsApp enviará mensajes a mis contactos ¿Cómo funciona el emparejamiento

No. La política predeterminada de WhatsApp DM está **emparejando**. Los remitentes desconocidos sólo obtienen un código de emparejamiento y su mensaje **no es procesado**. OpenClaw sólo responde a chats que recibe o a envíos explícitos que se activan.

Aprobar emparejamiento con:

```bash
openclaw pairing approve whatsapp <code>
```

Lista de solicitudes pendientes:

```bash
openclaw pairing list whatsapp
```

Indicación del número de teléfono del asistente: se utiliza para establecer su **lista permitida/propietario** para que sus propios DMs estén permitidos. No se utiliza para el envío automático. Si corres en tu número personal de WhatsApp, usa ese número y activa `channels.whatsapp.selfChatMode`.

## Comandos de chat, abortando tareas, y "no se detendrá"

### ¿Cómo puedo evitar que los mensajes del sistema interno se muestren en el chat

La mayoría de los mensajes internos o de herramientas solo aparecen cuando **verbose** o **razonamiento** está habilitado
para esa sesión.

Arreglar en el chat donde lo veas:

```
/verbose
/reasoning off
```

Si todavía es ruidoso, compruebe la configuración de sesión en la interfaz de control y establezca la precisión
a **hereda**. También confirma que no estás usando un perfil de bot con `verboseDefault` establece
a `on` en la configuración.

Docs: [Pensando y verbose](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).

### ¿Cómo dejo de cancelar una tarea en ejecución

Enviar cualquiera de estos **como un mensaje independiente** (sin barras):

```
detener
abortar
esc
esperar
salir
interrumpir
```

Estos son activadores de aborto (no comandos slash).

Para procesos en segundo plano (desde la herramienta exec), puede pedir al agente que ejecute:

```
proceso acción:matar sessionId:XXX
```

Vista general de comandos de barras: vea [Comandos de barras](/tools/slash-commands).

La mayoría de los comandos deben ser enviados como un mensaje **autónomo** que comienza con `/`, pero algunos accesos directos (como `/status`) también funcionan en línea para los remitentes listados.

### ¿Cómo puedo enviar un mensaje de Discord desde Telegram Crosscontext denegado

OpenClaw bloquea la mensajería de **cross-provider** por defecto. Si una llamada de herramienta está vinculada
a Telegram, no se enviará a Discord a menos que la permitas explícitamente.

Habilitar mensajería entre proveedores para el agente:

```json5
{
  agents: {
    defaults: {
      tools: {
        message: {
          crossContext: {
            allowAcrossProviders: true, Marcador de
            : { habilitado: true, prefijo: "[de {channel}] " },
          },
        },
      },
    },
  },
}
```

Reiniciar la puerta de enlace después de editar la configuración. Si solo quieres esto para un único agente
, establézcalo en `agents.list[].tools.message` en su lugar.

### ¿Por qué se siente que el bot ignora los mensajes de fuego rápido

El modo de cola controla cómo los mensajes nuevos interactúan con una ejecución en vuelo. Usa `/queue` para cambiar modos:

- `steer` - nuevos mensajes redireccionan la tarea actual
- `seguimiento` - ejecuta mensajes uno a la vez
- `collect` - agrupar mensajes y responder una vez (por defecto)
- `steer-backlog` - dirige ahora, luego procesa backlog
- `interrumpido` - aborta la ejecución actual e inicia fresco

Puedes añadir opciones como `debounce:2s cap:25 drop:summarize` para los modos de seguimiento.

## Responder a la pregunta exacta de la captura de pantalla/registro de chat

**P: "¿Cuál es el modelo predeterminado para Antropic con una clave API?"**

**R:** En OpenClaw, las credenciales y la selección de modelos son separadas. Configurar `ANTHROPIC_API_KEY` (o almacenar una clave de API Antrópica en perfiles de autenticación) habilita la autenticación, pero el modelo predeterminado es lo que configure en `agentes. efaults.model.primary` (por ejemplo, `anthropic/claude-sonnet-4-5` o `anthropic/claude-op)[video] 4-6`). Si ves `No se encontraron credenciales para el perfil "anthropic:default"`, significa que Gateway no pudo encontrar credenciales Antrópicas en los `auth-profiles`. son\` para el agente que está corriendo.

---

¿Aún atascado? Pregunte en [Discord](https://discord.com/invite/clawd) o abra una [discusión en GitHub](https://github.com/openclaw/openclaw/discussions).
