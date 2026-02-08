---
summary: "Preguntas frecuentes sobre la configuración, instalación y uso de OpenClaw"
title: "Preguntas frecuentes"
x-i18n:
  source_path: help/faq.md
  source_hash: b7c0c9766461f6e7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:35:36Z
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

---

¿Aún atascado? Pregunte en [Discord](https://discord.com/invite/clawd) o abra una [discusión en GitHub](https://github.com/openclaw/openclaw/discussions).
