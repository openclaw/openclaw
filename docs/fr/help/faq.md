---
summary: "Frequently asked questions about OpenClaw setup, configuration, and usage"
title: "FAQ"
---

# FAQ

Quick answers plus deeper troubleshooting for real-world setups (local dev, VPS, multi-agent, OAuth/API keys, model failover). For runtime diagnostics, see [Troubleshooting](/gateway/troubleshooting). For the full config reference, see [Configuration](/gateway/configuration).

## Table of contents

- [Quick start and first-run setup](#quick-start-and-firstrun-setup)
  - [Im stuck whats the fastest way to get unstuck?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [What's the recommended way to install and set up OpenClaw?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [How do I open the dashboard after onboarding?](#how-do-i-open-the-dashboard-after-onboarding)
  - [How do I authenticate the dashboard (token) on localhost vs remote?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [What runtime do I need?](#what-runtime-do-i-need)
  - [Does it run on Raspberry Pi?](#does-it-run-on-raspberry-pi)
  - [Any tips for Raspberry Pi installs?](#any-tips-for-raspberry-pi-installs)
  - [It is stuck on "wake up my friend" / onboarding will not hatch. What now?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [Can I migrate my setup to a new machine (Mac mini) without redoing onboarding?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [Where do I see what is new in the latest version?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [I can't access docs.openclaw.ai (SSL error). What now?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [What's the difference between stable and beta?](#whats-the-difference-between-stable-and-beta)
  - [How do I install the beta version, and what's the difference between beta and dev?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [How do I try the latest bits?](#how-do-i-try-the-latest-bits)
  - [How long does install and onboarding usually take?](#how-long-does-install-and-onboarding-usually-take)
  - [Installer stuck? How do I get more feedback?](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows install says git not found or openclaw not recognized](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [The docs didn't answer my question - how do I get a better answer?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [How do I install OpenClaw on Linux?](#how-do-i-install-openclaw-on-linux)
  - [How do I install OpenClaw on a VPS?](#how-do-i-install-openclaw-on-a-vps)
  - [Where are the cloud/VPS install guides?](#where-are-the-cloudvps-install-guides)
  - [Can I ask OpenClaw to update itself?](#can-i-ask-openclaw-to-update-itself)
  - [What does the onboarding wizard actually do?](#what-does-the-onboarding-wizard-actually-do)
  - [Do I need a Claude or OpenAI subscription to run this?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [Can I use Claude Max subscription without an API key](#can-i-use-claude-max-subscription-without-an-api-key)
  - [How does Anthropic "setup-token" auth work?](#how-does-anthropic-setuptoken-auth-work)
  - [Where do I find an Anthropic setup-token?](#where-do-i-find-an-anthropic-setuptoken)
  - [Do you support Claude subscription auth (Claude Code OAuth)?](#do-you-support-claude-subscription-auth-claude-code-oauth)
  - [Why am I seeing `HTTP 429: rate_limit_error` from Anthropic?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [Is AWS Bedrock supported?](#is-aws-bedrock-supported)
  - [How does Codex auth work?](#how-does-codex-auth-work)
  - [Do you support OpenAI subscription auth (Codex OAuth)?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [How do I set up Gemini CLI OAuth](#how-do-i-set-up-gemini-cli-oauth)
  - [Is a local model OK for casual chats?](#is-a-local-model-ok-for-casual-chats)
  - [How do I keep hosted model traffic in a specific region?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [Do I have to buy a Mac Mini to install this?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [Do I need a Mac mini for iMessage support?](#do-i-need-a-mac-mini-for-imessage-support)
  - [If I buy a Mac mini to run OpenClaw, can I connect it to my MacBook Pro?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Can I use Bun?](#can-i-use-bun)
  - [Telegram: what goes in `allowFrom`?](#telegram-what-goes-in-allowfrom)
  - [Can multiple people use one WhatsApp number with different OpenClaw instances?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [Can I run a "fast chat" agent and an "Opus for coding" agent?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Does Homebrew work on Linux?](#does-homebrew-work-on-linux)
  - [What's the difference between the hackable (git) install and npm install?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [Can I switch between npm and git installs later?](#can-i-switch-between-npm-and-git-installs-later)
  - [Should I run the Gateway on my laptop or a VPS?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [How important is it to run OpenClaw on a dedicated machine?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [What are the minimum VPS requirements and recommended OS?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [Can I run OpenClaw in a VM and what are the requirements](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [What is OpenClaw?](#what-is-openclaw)
  - [What is OpenClaw, in one paragraph?](#what-is-openclaw-in-one-paragraph)
  - [What's the value proposition?](#whats-the-value-proposition)
  - [I just set it up what should I do first](#i-just-set-it-up-what-should-i-do-first)
  - [What are the top five everyday use cases for OpenClaw](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [Can OpenClaw help with lead gen outreach ads and blogs for a SaaS](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [What are the advantages vs Claude Code for web development?](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills and automation](#skills-and-automation)
  - [Comment puis-je personnaliser mes compétences sans laisser le repo sali ?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [Puis-je charger des compétences depuis un dossier personnalisé ?](#can-i-load-skills-from-a-custom-folder)
  - [Comment puis-je utiliser différents modèles pour différentes tâches?] (#how-can-i-use-different-models-for-different-tasks)
  - [Le bot se fige, tout en faisant un travail lourd. Comment puis-je me décharger ?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron ou rappels ne tirent pas. Que dois-je vérifier?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [Comment puis-je installer des compétences sur Linux?](#how-do-i-install-skills-on-linux)
  - [OpenClaw peut-il exécuter des tâches sur un calendrier ou en continu en arrière-plan ?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Puis-je utiliser les compétences d'Apple macOS uniquement depuis Linux?](#can-i-run-apple-macos-only-skills-from-linux)
  - [Avez-vous une notion ou une intégration de HeyGen ?](#do-you-have-a-notion-or-heygen-integration)
  - [Comment puis-je installer l'extension Chrome pour la prise en charge du navigateur ?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Sandboxing and memory](#sandboxing-and-memory)
  - [Y a-t-il une doc de bac à sable dédiée?](#is-there-a-dedicated-sandboxing-doc)
  - [Comment lier un dossier hôte dans le bac à sable ?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [Comment fonctionne la mémoire ?](#how-does-memory-work)
  - [La mémoire oublie toujours les choses. Comment puis-je le faire coller?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [La mémoire persiste-t-elle pour toujours ? Quelles sont les limites ?](#does-memory-persist-forever-what-are-the-limits)
  - [La recherche de mémoire sémantique requiert-elle une clé API OpenAI ?](#does-semantic-memory-search-require-an-openai-api-key)
- [Where things live on disk](#where-things-live-on-disk)
  - [Toutes les données utilisées avec OpenClaw sont-elles sauvegardées localement ?](#is-all-data-used-with-openclaw-saved-locally)
  - [Ou OpenClaw stocke-t-il ses donnees ?](#where-does-openclaw-store-its-data)
  - [Où devrait vivre AGENTS.md / SOUL.md / USER.md / MEMORY.md ?](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [Quelle est la stratégie de sauvegarde recommandée ?](#whats-the-recommended-backup-strategy)
  - [Comment désinstaller complètement OpenClaw ?](#how-do-i-completely-uninstall-openclaw)
  - [Les agents peuvent-ils travailler en dehors de l'espace de travail?](#can-agents-work-outside-the-workspace)
  - [Je suis en mode distant - où est la boutique de session ?](#im-in-remote-mode-where-is-the-session-store)
- [Config basics](#config-basics)
  - [Quel est le format de la configuration ? Où est-ce?](#what-format-is-the-config-where-is-it)
  - [J'ai défini `gateway.bind: "lan"` (ou `"tailnet"`) et maintenant rien n'écoute / l'interface utilisateur non autorisée](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [Pourquoi ai-je besoin d'un jeton sur localhost maintenant?](#why-do-i-need-a-token-on-localhost-now)
  - [Dois-je redémarrer après la modification de la configuration ?](#do-i-have-to-restart-after-changing-config)
  - [Comment puis-je activer la recherche web (et la recherche web)?](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply a effacé ma configuration. Comment puis-je récupérer et éviter cela?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [Comment puis-je faire fonctionner une passerelle centrale avec des travailleurs spécialisés sur tous les appareils?] (#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [Le navigateur OpenClaw peut-il fonctionner sans tête ?](#can-the-openclaw-browser-run-headless)
  - [Comment utiliser Brave pour le contrôle du navigateur?](#how-do-i-use-brave-for-browser-control)
- [Remote gateways + nodes](#remote-gateways-nodes)
  - [Comment les commandes se propagent entre Telegram, la passerelle et les nœuds ?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [Comment mon agent peut-il accéder à mon ordinateur si la passerelle est hébergée à distance ?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale est connecté mais je n'ai pas de réponses. What now?](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [Deux instances OpenClaw peuvent-elles se parler (local + VPS)?](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [ai-je besoin de VPSes séparés pour plusieurs agents](#do-i-need-separate-vpses-for-multiple-agents)
  - [Y a-t-il un avantage d'utiliser un nœud sur mon ordinateur portable personnel au lieu de SSH d'un VPS ?](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [Les nœuds exécutent un service de passerelle ?](#do-nodes-run-a-gateway-service)
  - [Y a-t-il une méthode API / RPC pour appliquer la configuration ?](#is-there-an-api-rpc-way-to-apply-config)
  - [Quelle configuration "sane" minimale pour une première installation?](#whats-a-minimal-sane-config-for-a-first-install)
  - [Comment puis-je configurer l'échelle de queue sur un VPS et me connecter depuis mon Mac ?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [Comment puis-je connecter un nœud Mac à une passerelle distante (Tailscale Serve)?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [Devrais-je installer sur un deuxième ordinateur portable ou simplement ajouter un nœud ?](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [Env vars and .env loading](#env-vars-and-env-loading)
  - [Comment les variables d'environnement sont chargées par OpenClaw ?](#how-does-openclaw-load-environment-variables)
  - [« J'ai commencé la passerelle par le service et mes vars env ont disparu. » What now?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [J'ai défini `COPILOT_GITHUB_TOKEN`, mais le statut des modèles montre "Shell env: off: off." Pourquoi?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [Sessions & multiple chats](#sessions-multiple-chats)
  - [Comment démarrer une nouvelle conversation ?](#how-do-i-start-a-fresh-conversation)
  - [Est-ce que les sessions se réinitialisent automatiquement si je n'envoie jamais `/new`?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [Y a-t-il un moyen de faire une équipe d'instances d'OpenClaw un PDG et de nombreux agents](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [Pourquoi le contexte a-t-il été tronqué en milieu de tâche? Comment puis-je le prévenir ?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [Comment puis-je réinitialiser complètement OpenClaw mais le garder installé ?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [Je reçois des erreurs "contextuelles trop grandes" - comment puis-je réinitialiser ou compact?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [Pourquoi est-ce que je vois "Requête LLM rejetée: messages.N.content.X.tool_use.input: Field required"?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [Pourquoi suis-je victime de coups de cœur toutes les 30 minutes?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [Dois-je ajouter un "compte bot" à un groupe WhatsApp ?](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [Comment puis-je obtenir le JID d'un groupe WhatsApp ?](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [Pourquoi OpenClaw ne répond-il pas dans un groupe?](#why-doesnt-openclaw-reply-in-a-group)
  - [Est-ce que les groupes/sujets partagent le contexte avec les DMs?](#do-groupsthreads-share-context-with-dms)
  - [Combien d'espaces de travail et d'agents puis-je créer?](#how-many-workspaces-and-agents-can-i-create)
  - [Puis-je exécuter plusieurs bots ou chats en même temps (Slack), et comment devrais-je régler cela ?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [Models: defaults, selection, aliases, switching](#models-defaults-selection-aliases-switching)
  - [Qu'est-ce que le "modèle par défaut"?](#what-is-the-default-model)
  - [Quel modèle recommandez-vous ?](#what-model-do-you-recommend)
  - [Comment changer de modèle sans effacer ma configuration?](#how-do-i-switch-models-without-wiping-my-config)
  - [Puis-je utiliser des modèles auto-hébergés (llama.cpp, vLLM, Ollama)?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [Que font OpenClaw, Flawd et Krill pour les modèles?](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [Comment puis-je changer de modèle à la volée (sans redémarrer)?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [Puis-je utiliser GPT 5.2 pour les tâches quotidiennes et Codex 5.3 pour le codage](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [Pourquoi puis-je voir "Modèle … n'est pas autorisé" et alors aucune réponse ?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [Pourquoi puis-je voir "Modèle inconnu: minimax/MiniMax-M2.1"?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [Puis-je utiliser MiniMax comme valeur par défaut et OpenAI pour des tâches complexes ?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [Est-ce que opus / sonnet / gpt raccourcis intégrés ?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [Comment définir/remplacer les raccourcis du modèle (alias)?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [Comment ajouter des modèles d'autres fournisseurs comme OpenRouter ou Z.AI ?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [Model failover and "All models failed"](#model-failover-and-all-models-failed)
  - [Comment fonctionne le basculement ?](#how-does-failover-work)
  - [Que signifie cette erreur?] (#what-does-this-error-mean)
  - [Corriger la liste de contrôle pour `Aucun identifiant trouvé pour le profil "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [Pourquoi a-t-il aussi essayé Google Gemini et a échoué?](#why-did-it-also-try-google-gemini-and-fail)
- [Auth profiles: what they are and how to manage them](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [Qu'est-ce qu'un profil d'authentification?](#what-is-an-auth-profile)
  - [Quels sont les identifiants de profil typiques?](#what-are-typical-profile-ids)
  - [Puis-je contrôler quel profil d'authentification est essayé en premier ?](#can-i-control-which-auth-profile-is-tried-first)
  - [Clé OAuth vs API : quelle est la différence ?](#oauth-vs-api-key-whats-the-difference)
- [Gateway: ports, "already running", and remote mode](#gateway-ports-already-running-and-remote-mode)
  - [Quel port la passerelle utilise-t-elle?](#what-port-does-the-gateway-use)
  - [Pourquoi `openclaw gateway status` dit-il `Runtime: running` mais `RPC probe: failed`?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [Pourquoi `openclaw gateway status` montre-t-il `Config (cli)` et `Config (service)` différemment?](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [Que signifie déjà "une autre instance de passerelle est en train d'écouter?](#what-does-another-gateway-instance-is-already-listening-mean)
  - [Comment utiliser OpenClaw en mode distant (client se connecte à une passerelle ailleurs)?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [L'interface de contrôle dit "non autorisé" (ou continue à se reconnecter). What now?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [J'ai défini `gateway.bind: "tailnet"` mais il ne peut pas lier / rien écouter](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [Puis-je exécuter plusieurs passerelles sur le même hôte ?](#can-i-run-multiple-gateways-on-the-same-host)
  - [Que signifie "établissement de liaison invalide" / code 1008 ?](#what-does-invalid-handshake-code-1008-mean)
- [Logging and debugging](#logging-and-debugging)
  - [Où sont les logs?](#where-are-logs)
  - [Comment commencer/arrêter/redémarrer le service de passerelle ?](#how-do-i-startstoprestart-the-gateway-service)
  - [J'ai fermé mon terminal sous Windows - comment puis-je redémarrer OpenClaw ?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [La passerelle est en place, mais les réponses n'arrivent jamais. Que dois-je vérifier?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - ["Déconnecté de la passerelle : pas de raison" - Et maintenant?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands échoue avec des erreurs de réseau. Que dois-je vérifier?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI ne montre aucune sortie. Que dois-je vérifier?](#tui-shows-no-output-what-should-i-check)
  - [Comment puis-je arrêter complètement puis démarrer la passerelle?](#how-do-i-completely-stop-then-start-the-gateway)
  - [ELI5: `openclaw gateway restart` vs `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [Quelle est la façon la plus rapide d'obtenir plus de détails lorsque quelque chose échoue ?](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [Media & attachments](#media-attachments)
  - [Ma compétence a généré une image/PDF, mais rien n'a été envoyé](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [Security and access control](#security-and-access-control)
  - [Est-il sécuritaire d'exposer OpenClaw à des DMs entrants?](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [L'injection rapide n'est-elle qu'une préoccupation pour les robots publics ?](#is-prompt-injection-only-a-concern-for-public-bots)
  - [Si mon bot possède son propre compte GitHub ou son propre numéro de téléphone](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [Puis-je lui donner de l'autonomie par rapport à mes messages textuels et est aussi sûr] (#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [Puis-je utiliser des modèles moins chers pour des tâches personnelles d'assistant?](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [J'ai couru `/start` dans Telegram mais je n'ai pas obtenu de code d'appairage](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp : enverra-t-il un message à mes contacts ? Comment fonctionne l'appairage ?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [Chat commands, aborting tasks, and "it won't stop"](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [Comment puis-je empêcher les messages internes du système de s'afficher dans le chat](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [Comment puis-je arrêter/annuler une tâche en cours?](#how-do-i-stopcancel-a-running-task)
  - [Comment puis-je envoyer un message Discord depuis Telegram ? ("Message inter-contexte refusé")](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [Pourquoi est-ce que le bot "ignore" les messages à feu rapide ?](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## First 60 seconds if something's broken

1. **Quick status (first check)**

   ```bash
   openclaw status
   ```

   Fast local summary: OS + update, gateway/service reachability, agents/sessions, provider config + runtime issues (when gateway is reachable).

2. **Pasteable report (safe to share)**

   ```bash
   openclaw status --all
   ```

   Read-only diagnosis with log tail (tokens redacted).

3. **Daemon + port state**

   ```bash
   openclaw gateway status
   ```

   Shows supervisor runtime vs RPC reachability, the probe target URL, and which config the service likely used.

4. **Deep probes**

   ```bash
   openclaw status --deep
   ```

   Runs gateway health checks + provider probes (requires a reachable gateway). See [Health](/gateway/health).

5. **Tail the latest log**

   ```bash
   openclaw logs --follow
   ```

   If RPC is down, fall back to:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   File logs are separate from service logs; see [Logging](/logging) and [Troubleshooting](/gateway/troubleshooting).

6. **Run the doctor (repairs)**

   ```bash
   openclaw doctor
   ```

   Repairs/migrates config/state + runs health checks. See [Doctor](/gateway/doctor).

7. **Gateway snapshot**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   Asks the running gateway for a full snapshot (WS-only). See [Health](/gateway/health).

## Démarrage rapide et installation en premier lancement

### Je suis coincé quel est le moyen le plus rapide de me décoincer

Utilisez un agent IA local qui peut **voir votre machine**. C'est beaucoup plus efficace que de demander
dans Discord, parce que la plupart des cas "I'm stuck" sont des **problèmes de configuration locale ou d'environnement** que
aides distantes ne peuvent pas inspecter.

- \*\*Code Claude \*\*: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **Codex OpenAI** : [https://openai.com/codex/](https://openai.com/codex/)

Ces outils peuvent lire le dépôt, exécuter des commandes, inspecter les journaux et aider à corriger votre configuration au niveau machine (PATH, services, permissions, fichiers d’authentification). Donnez-leur le **checkout source complet** via
l'installation hackable (git):

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Ceci installe OpenClaw **à partir d'un checkout git**, afin que l'agent puisse lire le code + docs et la raison
sur la version exacte que vous exécutez. Vous pouvez toujours revenir à stable plus tard
en réexécutant l'installateur sans `--install-method git`.

Astuce : demandez à l'agent de **planifier et superviser** le correctif (étape par étape), puis exécutez uniquement les commandes
nécessaires. Cela permet de garder les changements légers et plus faciles à contrôler.

Si vous découvrez un vrai bug ou une correction, veuillez remplir un problème GitHub ou envoyer une PR:
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

Commencer avec ces commandes (partager les sorties lorsque vous demandez de l'aide) :

```bash
openclaw status
openclaw modèle l'état
médecin openclaw
```

Ce qu'ils font:

- `l'état openclaw`: instantané rapide de la vie de passerelle/agent + configuration de base.
- `l'état des modèles openclaw`: vérifie l'authentification du fournisseur + la disponibilité du modèle.
- `openclaw doctor`: valide et répare les problèmes de config/state courants.

Autres vérifications utiles de CLI : `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`.

Boucle de débogage rapide : [Les 60 premières secondes si quelque chose est cassé] (#first-60-seconds-if-somethings-broken).
Documentation d'installation : [Install](/install), [Drapeaux Installation] (/install/installer), [Updating](/install/updating).

### Quelle est la méthode recommandée pour installer et configurer OpenClaw

Le dépôt recommande de fonctionner à partir de la source et d'utiliser l'assistant d'intégration :

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw à la carte --install-daemon
```

L'assistant peut également construire automatiquement les ressources de l'interface utilisateur. Après avoir embarqué, vous exécutez généralement la passerelle sur le port **18789**.

Depuis la source (contributeurs/dev) :

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # auto-installe UI deps à la première exécution
openclaw à bord
```

Si vous n'avez pas encore d'installation globale, exécutez-la via `pnpm openclaw onboard`.

### Comment puis-je ouvrir le tableau de bord après l'intégration

L'assistant ouvre votre navigateur avec une URL de tableau de bord propre (non-tokenizé) juste après l'intégration et affiche également le lien dans le résumé. Gardez cet onglet ouvert; s'il n'a pas démarré, copier/coller l'URL imprimée sur la même machine.

### Comment puis-je authentifier le jeton du tableau de bord sur localhost vs remote

**Hôte local (même machine) :**

- Ouvrez `http://127.0.0.1:18789/`.
- Si elle demande l'identification, collez le jeton de `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`) dans les paramètres de l'interface de contrôle.
- Récupérez le depuis l'hôte de la passerelle : `openclaw config get gateway.auth.token` (ou générez-en un : `openclaw doctor --generate-gateway-token`).

**Pas sur localhost:**

- **Tailscale Serve** (recommandé): keep bind loopback, run `openclaw gateway --tailscale serve`, open `https://<magicdns>/`. Si `gateway.auth.allowTailscale` est `true`, les en-têtes d'identité satisfont l'authentification (pas de jeton).
- **Tailnet bind**: exécutez `openclaw gateway --bind tailnet --token "<token>"`, ouvrez `http://<tailscale-ip>:18789/`, collez le jeton dans les paramètres du tableau de bord.
- **tunnel SSH** : `ssh -N -L 18789:127.0.0.1:18789 user@host` puis ouvrez `http://127.0.0.1:18789/` et collez le jeton dans les paramètres de l’interface de contrôle.

Voir [Dashboard](/web/dashboard) et [surfaces Web] (/web) pour les modes de liaison et les détails d'authentification.

### De quel runtime ai-je besoin

Le noeud **>= 22** est requis. `pnpm` est recommandé. Bun n'est **pas recommandé** pour la passerelle.

### S'exécute-t-il sur Raspberry Pi

Oui. La passerelle est légère - liste de docs **512MB-1Go de RAM**, **1 core**, et environ **500MB**
disque pour un usage personnel, et notez qu'un **Raspberry Pi 4 peut le lancer**.

Si vous souhaitez plus de marge (journaux, médias, autres services), **2 Go sont recommandés**, mais ce n’est pas un minimum strict.

Astuce : un petit Pi/VPS peut héberger la passerelle, et vous pouvez associer des **nœuds** sur votre ordinateur portable/téléphone pour
écran/caméra/canvas local ou exécuter des commandes. Voir [Nodes](/nodes).

### N'importe quel conseil pour l'installation du Raspberry Pi

Version courte: ça marche, mais on s'attend à des bords approximatifs.

- Utilisez un OS **64-bit** et gardez Node >= 22.
- Préférez l'installation \*\*hackable (git) pour que vous puissiez voir les logs et mettre à jour rapidement.
- Commencez sans canaux/compétences, puis ajoutez-les un par un.
- Si vous rencontrez des problèmes binaires bizarres, c'est généralement un problème de **compatibilité ARM**.

Documents : [Linux](/platforms/linux), [Install](/install).

### Il est coincé au réveil, mon ami embarquera ne va pas écloire ce que maintenant

Cet écran dépend du fait que la passerelle est joignable et authentifiée. Le TUI envoie aussi
"Réveillez-vous, mon ami!" automatiquement à la première éclosion. Si vous voyez cette ligne avec **sans réponse**
et que les jetons restent à 0, l'agent ne courra jamais.

1. Redémarrez la Gateway:

```bash
openclaw gateway restart
```

2. Vérifier le statut + l'authentification :

```bash
openclaw status
openclaw modèle l'état
logs openclaw --follow
```

3. Si elle reste suspendue, exécutez :

```bash
openclaw doctor
```

Si la passerelle est distante, assurez-vous que la connexion tunnel/échelle de queue est en marche et que l'UI
est pointée sur la bonne passerelle. Voir [Remote access](/gateway/remote).

### Puis-je migrer mon installation vers une nouvelle machine Mac mini sans réintégrer

Oui. Copiez le **répertoire d'état** et **workspace**, puis exécutez Doctor une fois. Ce
conserve votre bot "exactement la même" (état de mémoire, de session, d'authentification et de canal
) tant que vous copiez **les deux** emplacements:

1. Installez OpenClaw sur la nouvelle machine.
2. Copiez `$OPENCLAW_STATE_DIR` (par défaut: `~/.openclaw`) de l'ancienne machine.
3. Copiez votre espace de travail (par défaut: `~/.openclaw/workspace`).
4. Exécutez `openclaw doctor` et redémarrez le service Gateway.

Cela préserve la config, les profils d'authentification, les créations WhatsApp, les sessions et la mémoire. Si vous êtes en mode distant, rappelez‑vous que l’hôte du gateway possède le stockage des sessions et l’espace de travail.

**Important:** si vous ne validez / envoyez votre espace de travail sur GitHub, vous soutenez
jusqu'à **mémoire + fichiers de bootstrap**, mais **pas** l'historique de session ou l'authentification des sessions. Ceux qui vivent à
dans `~/.openclaw/` (par exemple `~/.openclaw/agents/<agentId>/sessions/`).

Relatif : [Migrating](/install/migrating), [Où les choses vivent sur disque](/help/faq#where-does-openclaw-store-its-data),
[Espace de travail de l'agent](/concepts/agent-workspace), [Doctor](/gateway/doctor),
[Mode distant] (/gateway/remote).

### Où puis-je voir ce qui est nouveau dans la dernière version

Vérifiez le changelog:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

Les nouvelles entrées sont en haut. Si la section supérieure est marquée **Unreleased**, la section datée suivante est la dernière version publiée. Les entrées sont regroupées par **Surlignes**, **Changements**, et
**Corriges** (plus docs/autres sections lorsque nécessaire).

### Je ne peux pas accéder à docs.openclaw.ai erreur SSL maintenant

Certaines connexions Comcast/Xfinity bloquent incorrectement `docs.openclaw.ai` via Xfinity
Advanced Security. Désactivez ou autorisez `docs.openclaw.ai`, puis réessayez. Plus de
détail: [Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).
Aidez-nous à le débloquer en signalant ici : [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

Si vous ne parvenez toujours pas à rejoindre le site, les docs sont miroir sur GitHub :
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### Quelle est la différence entre stable et beta

**Stable** et **beta** sont des **npm dist-tags**, pas des lignes de code séparées :

- `latest` = stable
- `beta` = compilation anticipée pour tester

Nous envoyons des builds à **beta**, testez-les, et une fois qu'une build est solide, nous **promouvons
cette même version au `latest`**. C'est pourquoi la bêta et la stable peuvent pointer vers la
**même version**.

Voir ce qui a changé :
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### Comment puis-je installer la version bêta et quelle est la différence entre la béta et le développement

**Beta** est la balise npm dist-tag `beta` (peut correspondre à `latest`).
**Dev** est la tête de mouvement de `main` (git); lorsqu'elle est publiée, elle utilise la npm dist-tag `dev`.

One-liners (macOS/Linux):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Installateur Windows (PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

Plus de détails : [Canal de développement](/install/development-channels) et [Drapeaux de l'installateur](/install/installer).

### Combien de temps dure l'installation et l'intégration

Guide brutal:

- **Installation :** 2-5 minutes
- **Intégration :** 5-15 minutes selon le nombre de canaux/modèles que vous configurez

Si elle est suspendue, utilisez [Installer stuck](/help/faq#installer-stuck-how-do-i-get-more-feedback)
et la boucle de débogage rapide [Im stuck](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck).

### Comment puis-je essayer les derniers bits

Deux options :

1. **Canal Dev (checkout) :**

```bash
Mise à jour de openclaw --channel dev
```

Cela passe à la branche `main` et se met à jour depuis la source.

2. **Installation hackable (à partir du site de l'installateur):**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Cela vous donne un dépôt local que vous pouvez modifier, puis mettre à jour via git.

Si vous préférez un clone propre manuellement, utilisez :

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
build
```

Docs : [Update](/cli/update), [Canaux de développement](/install/development-channels),
[Install](/install).

### Installateur coincé Comment obtenir plus de commentaires

Ré-exécuter l'installateur avec **verbose output**:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

Installation bêta avec verbose :

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

Pour une installation hackable (git) :

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

Plus d'options : [Drapeaux de l'installateur] (/install/installer).

### L'installation de Windows dit que git n'est pas trouvé ou que openclaw n'est pas reconnu

Deux problèmes Windows communs :

**1) erreur npm spawn git / git introuvable**

- Installez **Git pour Windows** et assurez-vous que `git` est sur votre PATH.
- Fermez et rouvrez PowerShell, puis relancez l'installateur.

**2) openclaw n'est pas reconnu après l'installation**

- Votre dossier de corbeille npm global n'est pas sur PATH.

- Vérifier le chemin :

  ```powershell
  npm config get prefix
  ```

- Assurez-vous que `<prefix>\\bin` est sur PATH (sur la plupart des systèmes, c'est `%AppData%\\npm`).

- Fermer et rouvrir PowerShell après la mise à jour de PATH.

Si vous voulez une configuration Windows la plus fluide, utilisez **WSL2** au lieu de Windows natif.
Docs : [Windows](/platforms/windows).

### La documentation n'a pas répondu à ma question, comment puis-je obtenir une meilleure réponse

Utilisez l'installation \*\*hackable (git) pour que vous ayez la source et la documentation complète localement, alors demandez à
votre bot (ou Claude/Codex) _de ce dossier_ pour qu'il puisse lire le dépôt et répondre avec précision.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Plus de détails : [Install](/install) et [Drapeaux de l'installateur](/install/installer).

### Comment installer OpenClaw sur Linux

Réponse courte : suivez le guide Linux, puis exécutez l'assistant d'intégration.

- Chemin d'accès rapide Linux + installation du service : [Linux](/platforms/linux).
- Parcours complet : [Pour commencer] (/start/getting-started).
- Installer + mises à jour : [Installer & mettre à jour](/install/updating).

### Comment installer OpenClaw sur un VPS

Tous les VPS Linux fonctionnent. Installez sur le serveur, puis utilisez SSH/Tailscale pour atteindre la passerelle.

Guides : [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
Accès à distance : [Passerelle distante](/gateway/remote).

### Où sont les guides d'installation cloudVPS

Nous gardons un **hub d'hébergement** avec les fournisseurs communs. Choisissez-en un et suivez le guide :

- [VPS hosting](/vps) (tous les fournisseurs en un seul endroit)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

Comment ça marche dans le cloud : la **Gateway s'exécute sur le serveur**, et vous y accédez
depuis votre ordinateur portable/téléphone via l'interface utilisateur de contrôle (ou échelle de taille/SSH). Votre état + espace de travail
vivent sur le serveur, donc traitez l'hôte comme la source de vérité et sauvegardez-le.

Vous pouvez appairer des **nœuds** (Mac/iOS/Android/sans interface) à ce Gateway cloud pour accéder à l’écran/caméra/canvas locaux ou exécuter des commandes sur votre ordinateur portable tout en gardant le Gateway dans le cloud.

Hub: [Platforms](/platforms). Accès à distance : [Passerelle distante](/gateway/remote).
Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Puis-je demander à OpenClaw de se mettre à jour

Réponse courte : **possible, non recommandée**. Le flux de mise à jour peut redémarrer la passerelle
(qui supprime la session active), peut avoir besoin d'un checkout git propre, et
peut demander une confirmation. Plus sûr : exécutez les mises à jour depuis un shell en tant qu'opérateur.

Utiliser le CLI :

```bash
openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

Si vous devez automatiser depuis un agent :

```bash
openclaw update --yes --no-restart
openclaw gateway restart
```

Documents : [Update](/cli/update), [Updating](/install/updating).

### Que fait l'assistant d'intégration

`openclaw onboard` est le chemin de configuration recommandé. En **mode local** il vous traverse:

- **Configuration du modèle/auth** (**setup-token** Anthropic recommandé pour les abonnements Claude (OpenAI Codex OAuth supporté), clés API optionnelles, modèles locaux LM Studio pris en charge)
- Emplacement de **Workspace** + fichiers de bootstrap
- **Paramètres de passerelle** (bind/port/auth/tailscale)
- **Fournisseurs** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)
- **Installation du démon** (LaunchAgent sur macOS; systemd user unit sur Linux/WSL2)
- Sélection des **examens de santé** et des **compétences**

Il avertit également si votre modèle configuré est inconnu ou manquant.

### Ai-je besoin d'un abonnement Claude ou OpenAI pour exécuter ceci

Non. Vous pouvez exécuter OpenClaw avec des **clés API** (Anthropic/OpenAI/autres) ou avec des **modèles uniquement locaux** afin que vos données restent sur votre appareil. Les abonnements (Claude
Pro/Max ou OpenAI Codex) sont des moyens facultatifs pour authentifier ces fournisseurs.

Docs : [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[Modèles locals](/gateway/local-models), [Models](/concepts/models).

### Puis-je utiliser l'abonnement Claude Max sans clé API

Oui. Vous pouvez vous authentifier avec un **setup-token**
au lieu d'une clé API. Ceci est le chemin de l'abonnement.

Les abonnements Claude Pro/Max **n'incluent pas de clé API**, donc c'est l'approche
correcte pour les comptes d'abonnement. Important : vous devez vérifier avec
Anthropic que cette utilisation est autorisée selon leur politique et conditions d'abonnement.
Si vous voulez le chemin le plus explicite, le chemin est supporté, utilisez une clé API Anthropique.

### Comment fonctionne l'authentification Anthropic setuptoken

`claude setup-token` génère une **chaîne de jetons** via la CLI Claude Code (elle n'est pas disponible dans la console web). Vous pouvez l'exécuter sur **n'importe quelle machine**. Choisissez **Jeton Anthropic (collez le jeton setup-token)** dans l'assistant ou collez-le avec `openclaw models auth paste-token --provider anthropic`. Le jeton est stocké comme un profil d'authentification pour le fournisseur **anthropique** et utilisé comme une clé API (pas de mise à jour automatique). Plus de détails : [OAuth](/concepts/oauth).

### Où puis-je trouver un setuptoken Anthropic

Ce n'est **pas** dans la console anthropique. Le setup-token est généré par le **Claude Code CLI** sur **n'importe quelle machine** :

```bash
claude setup-token
```

Copiez le jeton qu'il affiche, puis choisissez **Jeton Anthropique (coller le jeton setup-token)** dans l'assistant. Si vous voulez l'exécuter sur l'hôte de la passerelle, utilisez `openclaw models auth setup-token --provider anthropic`. Si vous avez exécuté `claude setup-token` ailleurs, collez-le sur l'hôte de la passerelle avec `openclaw modèles auth paste-token --provider anthropic`. Voir [Anthropic](/providers/anthropic).

### Prends en charge l'authentification des abonnements Claude (Claude Pro ou Max)

Oui - via **setup-token**. OpenClaw ne réutilise plus les jetons Claude Code CLI OAuth ; utilisez un jeton d'installation ou une clé API Anthropique. Générez le jeton n'importe où et collez-le sur l'hôte de la passerelle. Voir [Anthropic](/providers/anthropic) et [OAuth](/concepts/oauth).

Note: L'accès à l'abonnement Claude est régi par les termes d'Anthropic. Pour la production ou les charges de travail multi-utilisateurs, les clés API sont généralement le choix le plus sûr.

### Pourquoi est-ce que je vois HTTP 429 ratelimiterror de Anthropic

Cela signifie que votre **limite de quota/taux anthropique** est épuisée pour la fenêtre actuelle. Si vous
utilisez un \*\*abonnement Claude \*\* (jeton d'installation ou Claude Code OAuth), attendez que la fenêtre à
réinitialise ou met à niveau votre plan. Si vous utilisez une **clé API Anthropique**, vérifiez la console Anthropic
pour l'utilisation/la facturation et augmentez les limites au besoin.

Astuce : définissez un **modèle de repli** pour qu'OpenClaw puisse continuer à répondre quand un fournisseur est limité au rythme.
Voir [Models](/cli/models) et [OAuth](/concepts/oauth).

### Est AWS Bedrock pris en charge

Oui - via le fournisseur **Amazon Bedrock (Converse)** de pi-ai avec **configuration manuelle**. Vous devez fournir les identifiants/régions AWS sur l'hôte de la passerelle et ajouter une entrée de fournisseur Bedrock dans la configuration de vos modèles. Voir [Amazon Bedrock](/providers/bedrock) et [Fournisseurs de modèles](/providers/models). Si vous préférez un flux de clés géré, un proxy compatible OpenAI devant Bedrock est toujours une option valide.

### Comment fonctionne l'authentification Codex

OpenClaw supporte **OpenAI Code (Codex)** via OAuth (connexion ChatGPT). L'assistant peut exécuter le flux OAuth et définira le modèle par défaut à `openai-codex/gpt-5.3-codex` le cas échéant. Voir [Fournisseurs de modèles](/concepts/model-providers) et [Wizard](/start/wizard).

### Prise en charge de l'authentification aux abonnements OpenAI Codex OAuth

Oui. OpenClaw supporte entièrement l'abonnement OAuth\*\* OpenAI Code (Codex). L'assistant d'intégration
peut exécuter le flux OAuth pour vous.

Voir [OAuth](/concepts/oauth), [Fournisseurs de modèles](/concepts/model-providers), et [Wizard](/start/wizard).

### Comment configurer Gemini CLI OAuth

Gemini CLI utilise un **flux d'authentification de plugin**, pas un identifiant client ou un secret dans `openclaw.json`.

Étapes :

1. Activer le plugin: `openclaw plugins enable google-gemini-cli-auth`
2. Connexion : `openclaw models auth login --provider google-gemini-cli --set-default`

Ceci stocke les jetons OAuth dans les profils d'authentification sur l'hôte de la passerelle. Détails: [Fournisseurs de modèles](/concepts/model-providers).

### Est un modèle local OK pour les conversations occasionnelles

Généralement non. OpenClaw a besoin d'un contexte large + de sécurité forte; les petites cartes tronquent et fuyent. Si vous le devez, exécutez la version **la plus grande** MiniMax M2.1, vous pouvez localement (LM Studio) et voir [/gateway/local-models](/gateway/local-models). Les modèles plus petits/quantifiés augmentent le risque d'injection rapide - voir [Security](/gateway/security).

### Comment conserver le trafic de modèles hébergés dans une région spécifique

Choisissez les terminaux épinglés par la région. OpenRouter expose les options hébergées aux États-Unis pour MiniMax, Kimi et GLM ; choisissez la variante hébergée aux États-Unis pour conserver les données dans la région. Vous pouvez toujours lister Anthropic/OpenAI à côté de ceux-ci en utilisant `models.mode: "fusion"` afin que les replis restent disponibles tout en respectant le fournisseur régional que vous sélectionnez.

### Dois-je acheter un Mac Mini pour installer ceci

Non. OpenClaw fonctionne sur macOS ou Linux (Windows via WSL2). Un Mac mini est optionnel - certaines personnes
en achètent un en tant qu'hôte permanent, mais un petit VPS, serveur domestique ou boîte de classe Raspberry Pi-fonctionne aussi.

Vous n'avez besoin que d'un Mac **pour les outils macOS**. Pour iMessage, utilisez [BlueBubbles](/channels/bluebubbles) (recommandé) - le serveur BlueBubbles fonctionne sur n'importe quel Mac, et la passerelle peut fonctionner sous Linux ou ailleurs. Si vous voulez d'autres outils uniquement pour macOS, exécutez la passerelle sur un Mac ou associez un nœud macOS.

Docs : [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes), [Mode distant Mac](/platforms/mac/remote).

### Ai-je besoin d'un Mac mini pour le support iMessage

Vous avez besoin de **un appareil macOS** connecté à Messages. Il ne doit **pas** être un Mac mini -
aucun Mac ne fonctionne. **Utilisez [BlueBubbles](/channels/bluebubbles)** (recommandé) pour iMessage - le serveur BlueBubbles fonctionne sur macOS, tandis que la passerelle peut fonctionner sur Linux ou ailleurs.

Installations courantes :

- Exécutez la passerelle sur Linux/VPS et exécutez le serveur BlueBubbles sur n'importe quel Mac connecté à Messages.
- Exécutez tout sur Mac si vous voulez la configuration la plus simple de la machine simple.

Docs : [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),
[mode distant Mac](/platforms/mac/remote).

### Si j'achète un Mac mini pour exécuter OpenClaw puis-je le connecter à mon MacBook Pro

Oui. Le **Mac mini peut exécuter la passerelle**, et votre MacBook Pro peut se connecter en tant que \*\*nœud
(périphérique compagnon). Les nœuds n'exécutent pas la passerelle - ils fournissent des capacités
supplémentaires comme l'écran/caméra/canvas et `system.run` sur cet appareil.

Modèle commun :

- Passerelle sur le Mac mini (toujours activé).
- MacBook Pro exécute l'application macOS ou un hôte de nœuds et associe la passerelle.
- Utilisez `openclaw nodes status` / `openclaw nodes list` pour le voir.

Docs : [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Puis-je utiliser Bun

Bun n’est **pas recommandé**. Nous voyons des bugs d'exécution, en particulier avec WhatsApp et Telegram.
Utilisez **Node** pour les passerelles stables.

Si vous voulez toujours expérimenter avec Bun, faites-le sur une passerelle de non-production
sans WhatsApp/Telegram.

### Telegram ce qui se passe dans allowFrom

`channels.telegram.allowFrom` est **l'ID utilisateur de Telegram de l'expéditeur humain** (numérique, recommandé) ou `@username`. Ce n'est pas le nom d'utilisateur du bot.

Plus sûr (sans bot tiers) :

- DM votre bot, puis exécutez `openclaw logs --follow` et lisez `from.id`.

API officielle du Bot :

- DM votre bot, puis appelez `https://api.telegram.org/bot<bot_token>/getUpdates` et lisez `message.from.id`.

Tiers (moins prive) :

- DM `@userinfobot` ou `@getidsbot`.

Voir [/channels/telegram](/channels/telegram#access-control-dms--groups).

### Peut plusieurs personnes utiliser un numéro WhatsApp avec différentes instances OpenClaw

Oui, via **routage multi-agents**. Lier la **DM** de WhatsApp de chaque expéditeur (type : "dm"`, expéditeur E. 64 comme `+15551234567`) à un `agentId` différent, donc chaque personne obtient son propre espace de travail et sa propre boutique de session. Les réponses proviennent toujours du **même compte WhatsApp**, et du contrôle d'accès aux DM (`channels.whatsapp.dmPolicy`/`channels.whatsapp.allowFrom\`) est global par compte WhatsApp. Voir [Routage multi-agents](/concepts/multi-agent) et [WhatsApp](/channels/whatsapp).

### Puis-je exécuter un agent de chat rapide et un agent de codage Opus

Oui. Utilisez le routage multi-agent : donnez à chaque agent son propre modèle par défaut, puis liez les routes entrantes (compte fournisseur ou pairs spécifiques) à chaque agent. Exemple de configuration vit dans [routage multi-agents](/concepts/multi-agent). Voir aussi [Models](/concepts/models) et [Configuration](/gateway/configuration).

### Est-ce que les Homebrew fonctionnent sous Linux

Oui. Homebrew supporte Linux (Linuxbrew). Demarrage rapide:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/bin/brew shellenv)"
brew install <formula>
```

Si vous exécutez OpenClaw via le système, assurez-vous que le service PATH inclut `/home/linuxbrew/.linuxbrew/bin` (ou votre préfixe brew) afin que les outils `brew`-installed résolvent dans les interpréteurs de commandes de non-connexion.
Les versions récentes préfixent également les répertoires de la corbeille sur les services système Linux (par exemple `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/. un/bin`) et honorez `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, et `FNM_DIR` lorsque défini.

### Quelle est la différence entre l'installation hackable de git et l'installation de npm

- **Installation hackable (git) :** checkout source complet, éditable, meilleur pour les contributeurs.
  Vous exécutez des compilations localement et pouvez patcher du code/docs.
- **npm install:** installation globale de CLI, pas de dépôt, mieux pour « juste exécuter ».
  Les mises à jour proviennent des tags dist-tag npm.

Docs : [Pour commencer](/start/getting-started), [Updating](/install/updating).

### Puis-je basculer entre npm et git plus tard

Oui. Installez l'autre saveur puis exécutez Doctor pour que le service de passerelle pointe au nouveau point d'entrée.
Ceci **ne supprime pas vos données** - cela ne modifie que l'installation du code OpenClaw . Votre état
(`~/.openclaw`) et l'espace de travail (`~/.openclaw/workspace`) restent intacts.

À partir de npm → git:

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
docteur openclaw
redémarrage de la passerelle openclaw
```

Doctor détecte une incompatibilité du point d'entrée du service passerelle et propose de réécrire la configuration du service pour correspondre à l'installation actuelle (utilisez `--réparair` dans l'automatique).

Conseils de sauvegarde : voir [stratégie de sauvegarde] (/help/faq#whats-the-recommended-backup-strategy).

### Devrais-je exécuter la passerelle sur mon ordinateur portable ou un VPS

Réponse brève: **si vous voulez une fiabilité 24/7, utilisez un VPS**. Si vous voulez le minimum de friction et que les mises en veille/redémarrages ne vous posent pas de problème, exécutez‑le localement.

**Ordinateur portable (passerelle locale)**

- **Pros:** sans coût de serveur, accès direct aux fichiers locaux, fenêtre du navigateur en direct.
- **Cons:** mise en veille/cache réseau = déconnexions, interruption des mises à jour/redémarrage du système d'exploitation, doit rester allumée.

**VPS / cloud**

- **Pros:** toujours-on, réseau stable, pas de problèmes de sommeil des ordinateurs portables, plus facile de continuer.
- **Cons:** exécute souvent sans tête (utiliser des captures d'écran), accès aux fichiers distants uniquement, vous devez SSH pour les mises à jour.

**Note spécifique à OpenClaw :** WhatsApp/Telegram/Slack/Mattermost (plugin)/Discord fonctionnent très bien depuis un VPS. Le seul compromis réel est **navigateur sans en-tête** par rapport à une fenêtre visible. Voir [Browser](/tools/browser).

**Par défaut recommandé:** VPS si vous aviez des déconnexions de passerelle avant. La locale est idéale lorsque vous utilisez activement le Mac et que vous voulez un accès local aux fichiers ou une automatisation de l'interface utilisateur avec un navigateur visible.

### Quelle importance attachez-vous à utiliser OpenClaw sur une machine dédiée

Pas obligatoire, mais **recommandé pour la fiabilité et l'isolation**.

- **Hébergement dédié (VPS/Mac mini/Pi) :** toujours moins d'interruptions de mise en veille/redémarrage, autorisations de nettoyage, plus facile à continuer.
- **Ordinateur portable/bureau partagé:** parfaitement adapté aux tests et aux utilisations actives, mais s'attend à des pauses lorsque la machine se met en veille ou se met à jour.

Si vous voulez le meilleur des deux mondes, Gardez la passerelle sur un hôte dédié et associez votre ordinateur portable en tant que **nœud** pour les outils d'écran/caméra/exec locaux. Voir [Nodes](/nodes).
Pour obtenir des conseils de sécurité, lisez [Security](/gateway/security).

### Quelles sont les exigences minimales de VPS et le système d'exploitation recommandé

OpenClaw est léger. Pour une passerelle de base + un canal de discussion :

- **Minimum absolu :** 1 vCPU, 1 Go de RAM, ~500Mo de disque.
- **Recommandé :** 1-2 vCPU, 2Go de RAM ou plus pour les entrées (logs, médias, canaux multiples). Les outils de nœud et l'automatisation des navigateurs peuvent avoir faim de ressources.

OS : utilisez **Ubuntu LTS** (ou n'importe quel Debian/Ubuntu). Le chemin d'installation de Linux y est le mieux testé.

Docs : [Linux](/platforms/linux), [VPS hosting](/vps).

### Puis-je utiliser OpenClaw dans une VM et quelles sont les exigences

Oui. Traiter une VM comme un VPS : elle doit être toujours allumée, accessible, et ont assez de mémoire vive
pour la passerelle et tous les canaux que vous activez.

Orientation de base :

- **Minimum absolu :** 1 vCPU, 1 Go de RAM.
- **Recommandé :** 2 Go de RAM ou plus si vous exécutez plusieurs canaux, l'automatisation du navigateur ou des outils multimédia.
- **OS:** Ubuntu LTS ou un autre Debian/Ubuntu.

Si vous êtes sous Windows, **WSL2 est la configuration de style VM la plus facile** et possède la meilleure compatibilité avec les outils
. Voir [Windows](/platforms/windows), [VPS hosting](/vps).
Si vous utilisez macOS dans une VM, voir [macOS VM](/install/macos-vm).

## Qu’est-ce qu’OpenClaw ?

### Qu'est-ce que OpenClaw dans un paragraphe

OpenClaw est un assistant IA personnel que vous exécutez sur vos propres appareils. Il répond sur les surfaces de messagerie que vous utilisez déjà (WhatsApp, Telegram, Slack, Mattermost (plugin), Discord, Google Chat, Signal, iMessage, WebChat) et peut également faire voix + un Canvas en direct sur les plateformes prises en charge. La **Passerelle** est l'avion de contrôle permanent ; l'assistant est le produit.

### Quelle est la proposition de valeur

OpenClaw n'est pas « un couvre-chef Claude ». C’est un **plan de contrôle local‑d’abord** qui vous permet d’exécuter un assistant performant sur **votre propre matériel**, accessible depuis les applications de chat que vous utilisez déjà, avec des sessions persistantes, de la mémoire et des outils — sans confier le contrôle de vos workflows à un SaaS hébergé.

Points forts :

- **Vos périphériques, vos données :** exécutez la passerelle où vous voulez (Mac, Linux, VPS) et gardez l'espace de travail* l'historique des sessions en local.
- **Les canaux réels, pas un bac à sable web :** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,
  plus la voix mobile et Canvas sur les plateformes prises en charge.
- **Indépendant du modèle :** utilisez Anthropic, OpenAI, MiniMax, OpenRouter, etc., avec routage et bascule par agent.
- **Option locale uniquement:** exécutez des modèles locaux afin que **toutes les données puissent rester sur votre appareil** si vous le souhaitez.
- **Routage multi-agents :** agents séparés par canal, compte ou tâche, chacun avec son propre espace de travail
  et par défaut.
- **Open source et hackable :** inspecter, étendre et auto-héberger sans verrouillage par le vendeur.

Documents : [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### Je viens de configurer ce que je devrais faire en premier

Les bons premiers projets:

- Construire un site web (WordPress, Shopify, ou un simple site statique).
- Prototype d'une application mobile (contour, écran, plan API).
- Organiser les fichiers et les dossiers (nettoyage, nommage, tagging).
- Connectez Gmail et automatisez les résumés ou les suivis.

Il peut gérer de grandes tâches, mais il fonctionne mieux lorsque vous les divisez en phases et
utiliser des sous-agents pour un travail parallèle.

### Quels sont les cinq premiers cas d'utilisation quotidienne pour OpenClaw

Les victoires de tous les jours ressemblent généralement à :

- **briefings personnels:** Résumés de la boîte de réception, du calendrier et des nouvelles qui vous intéressent.
- **Recherche et rédaction :** recherche rapide, résumés et premiers brouillons pour les e-mails ou les documentations.
- **Rappels et suivi :** coups de cron ou coups de coeur et listes de contrôle.
- **Automatisation du navigateur:** remplir des formulaires, collecter des données et répéter des tâches web.
- **Coordination entre les appareils :** envoyer une tâche depuis votre téléphone, laisser la passerelle l'exécuter sur un serveur, et récupérer le résultat dans le chat.

### Est-ce qu'OpenClaw peut aider les publicités et les blogs pour un SaaS sur les technologies de pointe en matière de technologie de pointe

Oui pour **la recherche, la qualification et la rédaction**. Il peut scanner des sites, construire des listes de raccourcis,
résumer des prospects, et écrire des brouillons de proximité ou de copie publicitaire.

Pour **faire de la publicité ou de la publicité**, gardez un humain dans la boucle. Évitez les spams, suivez les lois locales et les politiques de la plateforme
et examinez tout avant de les envoyer. Le schéma le plus sûr consiste à laisser OpenClaw rédiger et à vous faire approuver.

Docs : [Security](/gateway/security).

### Quels sont les avantages vs Claude Code pour le développement web

OpenClaw est un **assistant personnel** et une couche de coordination, pas un remplacement IDE. Utilisez
Claude Code ou Codex pour la boucle de codage direct la plus rapide à l'intérieur d'un dépôt. Utilisez OpenClaw lorsque vous voulez une mémoire durable, un accès multi‑appareils et une orchestration d’outils.

Avantages :

- **Mémoire persistante + espace de travail** à travers les sessions
- **Accès multi-plateforme** (WhatsApp, Telegram, TUI, WebChat)
- **orchestration d'outils** (navigateur, fichiers, planification, crochets)
- **Passerelle permanente** (fonctionne sur un VPS, interagissez depuis n'importe où)
- **Nodes** pour navigateur/écran/caméra/exec local

Showcase : [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## Compétences et automatisation

### Comment personnaliser les compétences sans laisser le dépôt sale

Utiliser les substitutions gérées au lieu de modifier la copie du dépôt. Mettez vos modifications dans `~/.openclaw/skills/<name>/SKILL.md` (ou ajoutez un dossier via `skills.load.extraDirs` dans `~/.openclaw/openclaw.json`). La préséance est `<workspace>/skills` > `~/.openclaw/skills` > bundled, donc les surcharges gérées gagnent sans toucher git. Seuls les montages en amont devraient vivre dans le dépôt et sortir en tant que RP.

### Puis-je charger des compétences à partir d'un dossier personnalisé

Oui. Ajoutez des répertoires supplémentaires via `skills.load.extraDirs` dans `~/.openclaw/openclaw.json` (priorité la plus basse). La priorité par défaut reste : `<workspace>/skills` → `~/.openclaw/skills` → bundled → `skills.load.extraDirs`. `clawhub` installe dans `./skills` par défaut, que OpenClaw traite comme `<workspace>/skills`.

### Comment puis-je utiliser différents modèles pour différentes tâches

Aujourd'hui, les pratiques supportées sont:

- **Tâches Cron**: les tâches isolées peuvent définir une substitution de `modèle` par tâche.
- **Sous-agents**: router les tâches vers des agents séparés avec différents modèles par défaut.
- **Basculement à la demande**: utilisez `/model` pour changer le modèle de session actuel à tout moment.

Voir [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent), et [Slash commands](/tools/slash-commands).

### Le bot se bloque tout en faisant un travail lourd Comment puis-je le décharger

Utilisez des **sous-agents** pour des tâches longues ou parallèles. Les sous-agents s'exécutent dans leur propre session,
renvoient un résumé et gardent votre chat principal.

Demandez à votre bot de "faire apparaître un sous-agent pour cette tâche" ou utilisez `/subagents`.
Utilisez `/status` dans le chat pour voir ce que la passerelle fait maintenant (et si elle est occupée).

Astuce de jeton : les tâches longues et les sous-agents consomment tous deux des jetons. Si le coût est une préoccupation, définissez un modèle
moins cher pour les sous-agents via `agents.defaults.subagents.model`.

Docs : [Sub-agents](/tools/subagents).

### Cron ou rappels ne tirent pas Que dois-je vérifier

Cron s'exécute à l'intérieur du processus de la passerelle. Si le Gateway ne fonctionne pas en continu, les tâches planifiées ne s’exécuteront pas.

Checklist:

- La confirmation de cron est activée (`cron.enabled`) et `OPENCLAW_SKIP_CRON` n'est pas défini.
- Vérifiez que la passerelle fonctionne 24 heures sur 24 et 7 jours sur 7 (sans sommeil/redémarrage).
- Vérifier les paramètres de fuseau horaire pour la tâche (`--tz` vs host timezone).

Debug:

```bash
openclaw cron exécute <jobId> --force
openclaw cron exécute --id <jobId> --limit 50
```

Docs : [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat).

### Comment installer des compétences sur Linux

Utilisez **ClawHub** (CLI) ou déposez vos compétences dans votre espace de travail. L'interface des compétences macOS n'est pas disponible sur Linux.
Parcourez les compétences à [https://clawhub.com](https://clawhub.com).

Installer ClawHub CLI (choisir un gestionnaire de paquets):

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### OpenClaw peut-il exécuter des tâches sur un calendrier ou en continu en arrière-plan

Oui. Utiliser le planificateur de passerelle :

- **Tâches Cron** pour les tâches planifiées ou récurrentes (persistent à travers les redémarrage).
- **Heartbeat** pour les vérifications périodiques de la "session principale".
- **Emplois isolés** pour les agents autonomes qui postent des résumés ou livrent des chats.

Docs : [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),
[Heartbeat](/gateway/heartbeat).

### Puis-je utiliser les compétences d'Apple MacOS uniquement avec Linux?

Pas directement. les compétences macOS sont portées par `metadata.openclaw.os` plus les binaires requis, et les compétences n'apparaissent dans l'invite du système que si elles sont éligibles sur l'**hôte de la passerelle**. Sous Linux, les compétences `darwin`-only (comme `apple-notes`, `apple-reminders`, `things-mac`) ne se chargeront pas à moins que vous ne remplaciez la portée.

Vous avez trois modèles supportés :

\*\*Option A - exécutez la passerelle sur un Mac (plus simple). \*
Exécutez la passerelle où les binaires macOS existent, puis connectez-vous depuis Linux en [mode distant](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) ou en échelle de taille. La charge des compétences normalement parce que l'hôte de la passerelle est macOS.

\*\*Option B - utiliser un nœud macOS (pas de SSH). \*
Exécuter la passerelle sous Linux, jumeler un nœud macOS (application menubar), et définissez **Commandes d'Exécution du Node** sur "Toujours demander" ou "Toujours autoriser" sur le Mac. OpenClaw peut traiter les compétences macOS comme éligibles lorsque les binaires requis existent sur le nœud. L'agent gère ces compétences via l'outil `nodes`. Si vous choisissez "Toujours demander", approuver "Toujours autoriser" dans l'invite ajoute cette commande à la liste d'autorisations.

\*\*Option C - binaires macOS proxy via SSH (avancés). \*
Garder la passerelle sous Linux, mais faire en sorte que les binaires CLI nécessaires soient résolus aux gestionnaires SSH qui fonctionnent sur un Mac. Ensuite outrepasser la compétence pour permettre à Linux de rester éligible.

1. Créer un wrapper SSH pour le binaire (exemple : `memo` pour les notes d'Apple ) :

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

2. Mettez le wrapper sur `PATH` sur l'hôte Linux (par exemple `~/bin/memo`).

3. Remplacer les métadonnées de la compétence (espace de travail ou `~/.openclaw/skills`) pour autoriser Linux:

   ```markdown
   ---
   nom: apple-notes
   description : Gérez les notes Apple via le mémo CLI sur macOS.
   métadonnées : { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } }
   ---
   ```

4. Commencez une nouvelle session pour que l’instantané des compétences se rafraîchisse.

### Avez-vous une intégration Notion ou HeyGen

Pas intégré aujourd'hui.

Options :

- **Compétence personnalisée / plugin :** le mieux pour un accès fiable à l'API (Notion/HeyGen ont tous les deux des API).
- **Automatisation du navigateur:** fonctionne sans code mais est plus lent et plus fragile.

Si vous voulez conserver le contexte par client (flux de travail de l'agence), un modèle simple est :

- Une page de notion par client (contexte + préférences + travail actif).
- Demandez à l'agent de récupérer cette page au début d'une session.

Si vous voulez une intégration native, ouvrez une demande de fonctionnalité ou construisez une compétence
ciblant ces API.

Compétences d'installation :

```bash
clawhub installe <skill-slug>
clawhub update --all
```

ClawHub s'installe dans `. skills` dans votre répertoire actuel (ou tombe dans votre espace de travail OpenClaw configuré); OpenClaw le traite comme `<workspace>/skills` lors de la prochaine session. Pour partager des compétences entre les agents, placez-les dans `~/.openclaw/skills/<name>/SKILL.md`. Certaines compétences s'attendent à des binaires installés via Homebrew; sous Linux, cela signifie Linuxbrew (voir l'entrée de la FAQ Homebrew Linux ci-dessus). Voir [Skills](/tools/skills) et [ClawHub](/tools/clawhub).

### Comment installer l'extension Chrome pour la prise en charge du navigateur

Utilisez l'installateur intégré, puis chargez l'extension décompressée dans Chrome :

```bash
openclaw browser extension install
openclaw browser extension path
```

Ensuite, Chrome → `chrome://extensions` → activez le "Mode développeur" → "Charger décompressé" → choisissez ce dossier.

Guide complet (y compris la passerelle distante + notes de sécurité) : [Extension Chrome](/tools/chrome-extension)

Si la passerelle s'exécute sur la même machine que Chrome (configuration par défaut), vous **n'aurez généralement pas** besoin de rien de plus.
Si la Gateway (passerelle) s’exécute ailleurs, exécutez un hôte de nœud sur la machine du navigateur afin que la Gateway (passerelle) puisse proxifier les actions du navigateur.
Vous devez toujours cliquer sur le bouton d'extension dans l'onglet que vous voulez contrôler (il ne s'attache pas automatiquement).

## Bac à sable et mémoire

### Y a-t-il un doc de bac à sable dédié

Oui. Voir [Sandboxing](/gateway/sandboxing). Pour une configuration spécifique à Docker (passerelle complète dans les images Docker ou bac à sable), voir [Docker](/install/docker).

### Docker se sent limité Comment puis-je activer toutes les fonctionnalités

L’image par défaut est axée sécurité et s’exécute en tant qu’utilisateur `node`, elle n’inclut donc pas les paquets système, Homebrew ni des navigateurs intégrés. Pour une installation plus complète :

- Persiste `/home/node` avec `OPENCLAW_HOME_VOLUME` afin que les caches survivent.
- Cuire le système dans l'image avec `OPENCLAW_DOCKER_APT_PACKAGES`.
- Installez les navigateurs Playwright via le CLI:
  `node /app/node_modules/playwright-core/cli.js installer chromium`
- Définissez `PLAYWRIGHT_BROWSERS_PATH` et assurez-vous que le chemin est maintenu.

Documents : [Docker](/install/docker), [Browser](/tools/browser).

**Puis-je garder les MP personnels mais rendre les groupes publics en bac à sable avec un agent**

Oui - si votre trafic privé est **DMs** et que votre trafic public est **groups**.

Utilisez `agents.defaults.sandbox.mode: "non-main"` afin que les sessions groupe/canaux (clés non-principales) s'exécutent dans Docker, tandis que la session principale du DM reste sur l'hôte. Ensuite, restreignez les outils disponibles dans les sessions en bac à sable via `tools.sandbox.tools`.

Configuration de walkthrough + exemple de configuration : [Groupes : DMs personnels + groupes publics](/channels/groups#pattern-personal-dms-public-groups-single-agent)

Référence de configuration de la clé : [Configuration de la passerelle](/gateway/configuration#agentsdefaultssandbox)

### Comment lier un dossier hôte au sandbox

Définissez `agents.defaults.sandbox.docker.binds` à `["host:path:mode"]` (par exemple, `"/home/user/src:/src:ro"`). Global + par agent associe la fusion; les liaisons par agent sont ignorées lorsque `scope: "shared"`. Utilisez `:ro` pour tout ce qui est sensible et souvenez-vous des liaisons contourner les murs du système de fichiers sandbox. Voir [Sandboxing](/gateway/sandboxing#custom-bind-mounts) et [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) pour des exemples et des notes de sécurité.

### Comment fonctionne la mémoire

La mémoire OpenClaw n'est que des fichiers Markdown dans l'espace de travail de l'agent :

- Notes quotidiennes en `mémoire/YYYY-MM-DD.md`
- Notes à long terme conservées dans `MEMORY.md` (sessions main/private seulement)

OpenClaw exécute également une **mémoire de pré-compression silencieuse** pour rappeler au modèle
d'écrire des notes durables avant la compression automatique. Cela ne s'exécute que lorsque l'espace de travail
est accessible en écriture (les boîtes de sable en lecture seule ignorent). Voir [Memory](/concepts/memory).

### La mémoire oublie sans cesse les choses comment je les fais coller.

Demandez au bot de **écrire le fait en mémoire**. Les notes à long terme appartiennent à `MEMORY.md`,
le contexte à court terme va dans `memory/YYYY-MM-DD.md`.

C'est encore un domaine que nous sommes en train d'améliorer. Cela aide à rappeler au modèle de stocker des souvenirs ;
il saura quoi faire. S'il oublie toujours, vérifiez que la passerelle utilise le même espace de travail
à chaque exécution.

Docs : [Memory](/concepts/memory), [Espace de travail de l'agent](/concepts/agent-workspace).

### La recherche dans la mémoire sémantique requiert-elle une clé API OpenAI

Uniquement si vous utilisez des \*\* embeddings OpenAI \*\*. Codex OAuth couvre le tchat/complétions et
n'accorde **pas** l'accès aux incorporations donc **se connecter avec Codex (OAuth ou
connexion CLI Codex)** n'aide pas pour la recherche de mémoire sémantique. OpenAI embeddings
a toujours besoin d'une vraie clé API (`OPENAI_API_KEY` ou `models.providers.openai.apiKey`).

Si vous ne définissez pas de fournisseur explicitement, OpenClaw sélectionne automatiquement un fournisseur quand il
peut résoudre une clé API (profils d'authentification, `models.providers.*.apiKey`, ou env vars).
Il préfère OpenAI si une clé OpenAI est résolue, sinon Gemini si une clé Gemini
est résolue. Si aucune des deux clés n’est disponible, la recherche de mémoire reste désactivée jusqu’à ce que vous la configuriez. Si vous avez un chemin de modèle local configuré et présent, OpenClaw
préfère `local`.

Si vous préférez rester local, définissez `memorySearch.provider = "local"` (et optionnellement
`memorySearch.fallback = "none"`). Si vous voulez des embeddings Gemini, définissez
`memorySearch.provider = "gemini"` et fournissez `GEMINI_API_KEY` (ou
`memorySearch.remote.apiKey`). Nous prenons en charge les modèles **OpenAI, Gemini, ou local** incorporant* voir [Memory](/concepts/memory) pour les détails de l'installation.

### Est-ce que la mémoire persiste pour toujours Quelles sont les limites

Les fichiers de mémoire vivent sur le disque et persistent jusqu'à ce que vous les supprimiez. La limite est votre stockage
et non le modèle. Le **contexte de session** est toujours limité par la fenêtre de contexte du modèle
, donc de longues conversations peuvent être compactes ou tronquées. C'est pourquoi une recherche de mémoire
existe - elle ne ramène que les parties pertinentes dans le contexte.

Documents : [Memory](/concepts/memory), [Context](/concepts/context).

## Là où les choses vivent sur le disque

### Toutes les données utilisées avec OpenClaw sont enregistrées localement

Non - **L'état d'OpenClaw est local**, mais **les services externes voient toujours ce que vous leur envoyez**.

- **Local par défaut:** sessions, fichiers mémoire, configuration et espace de travail en direct sur l'hôte de passerelle
  (`~/.openclaw` + votre dossier d'espace de travail).
- **Distante par nécessité:** messages que vous envoyez aux fournisseurs de modèles (Anthropic/OpenAI/etc.) aller à
  leurs APIs, et leurs plateformes de chat (WhatsApp/Telegram/Slack/etc.) stocker les données des messages sur leurs serveurs
  .
- **Vous contrôlez l'empreinte :** en utilisant des modèles locaux garde les invites sur votre machine, mais le trafic du canal
  passe toujours par les serveurs du canal.

Relatif : [Espace de travail de l'agent](/concepts/agent-workspace), [Memory](/concepts/memory).

### Où est-ce que OpenClaw stocke ses données

Tout ce qui vit sous `$OPENCLAW_STATE_DIR` (par défaut: `~/.openclaw`):

| Chemin d'accès                                                  | Objectif                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | Configuration principale (JSON5)                                                                |
| `$OPENCLAW_STATE_DIR/identifiants/oauth.json`                   | Import OAuth hérité (copié dans les profils d'authentification lors de la première utilisation) |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | Profils d'authentification (OAuth + Clés API)                                                   |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | Cache d'authentification d'exécution (géré automatiquement)                                     |
| `$OPENCLAW_STATE_DIR/credentials/`                              | Etat du fournisseur (par exemple `whatsapp/<accountId>/creds.json`)                             |
| `$OPENCLAW_STATE_DIR/agents/`                                   | Etat par agent (agentDir + sessions)                                                            |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | Historique et état de la conversation (par agent)                                               |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | Métadonnées de session (par agent)                                                              |

Chemin de l'ancien mono-agent : `~/.openclaw/agent/*` (migré par `openclaw doctor`).

Votre **espace de travail** (AGENTS.md, fichiers mémoire, compétences, etc.) est séparé et configuré via `agents.defaults.workspace` (par défaut: `~/.openclaw/workspace`).

### Où devrait vivre AGENTSmd SOULmd USERmd MEMORYmd

Ces fichiers vivent dans **l'espace de travail de l'agent**, pas `~/.openclaw`.

- **Espace de travail (par agent)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md` (ou `memory.md`), `memory/YYY-MM-DD.md`, optionnel `HEARTBEAT.md`.
- **State dir (`~/.openclaw`)**: config, credentials, auth profiles, sessions, logs,
  et compétences partagées (`~/.openclaw/skills`).

L'espace de travail par défaut est `~/.openclaw/workspace`, configurable via :

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

Si le bot "oublie" après un redémarrage, confirmez que la passerelle utilise le même espace de travail
à chaque lancement (et rappelez-vous : le mode distant utilise l'espace de travail **passerelle**
pas votre ordinateur portable).

Astuce : si vous voulez un comportement ou une préférence durables, demandez au bot de **l'écrire dans
AGENTS. d ou MEMORY.md** plutôt que de s'appuyer sur l'historique des discussions.

Voir [Espace de travail de l'agent](/concepts/agent-workspace) et [Memory](/concepts/memory).

### Quelle est la stratégie de sauvegarde recommandée

Placez votre **espace de travail de l'agent** dans un **dépôt privé** git et sauvegardez-le quelque part
privé (par exemple GitHub). Cela capture la mémoire + les fichiers AGENTS/SOUL/USER
, et vous permet de restaurer "l'esprit" de l'assistant plus tard.

Ne **pas** livrer quoi que ce soit sous `~/.openclaw` (identifiants, sessions, jetons).
Si vous avez besoin d'une restauration complète, sauvegardez à la fois l'espace de travail et le répertoire d'état
séparément (voir la question de migration ci-dessus).

Documents : [Espace de travail de l'agent](/concepts/agent-workspace).

### Comment désinstaller complètement OpenClaw

Consultez le guide dédié : [Uninstall](/install/uninstall).

### Les agents peuvent travailler en dehors de l'espace de travail

Oui. L'espace de travail est **cwd par défaut** et l'ancre mémoire, pas un bac à sable dur.
Chemins relatifs résolus à l'intérieur de l'espace de travail, mais les chemins absolus peuvent accéder à d'autres emplacements
sauf si le sandboxing est activé. Si vous avez besoin d'isolation, utilisez
[`agents.defaults.sandbox`](/gateway/sandboxing) ou les paramètres du bac à sable par agent. Si vous voulez qu’un dépôt soit le répertoire de travail par défaut, pointez le `workspace` de cet agent vers la racine du dépôt. Le repo OpenClaw est juste du code source ; gardez l'espace de travail
séparé à moins que vous ne vouliez intentionnellement que l'agent y travaille.

Exemple (dépôt comme cwd par défaut) :

```json5
{
  agents: {
    par défaut : {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### Je suis en mode distant où se trouve la boutique de session

L'état de session appartient à **l'hôte de passerelle**. Si vous êtes en mode distant, le magasin de sessions dont vous vous souciez est sur la machine distante et non sur votre ordinateur portable local. Voir [Gestion de la session](/concepts/session).

## Bases de la configuration

### Quel est le format de la configuration Où est il

OpenClaw lit une configuration optionnelle de **JSON5** depuis `$OPENCLAW_CONFIG_PATH` (par défaut: `~/.openclaw/openclaw.json`):

```
$OPENCLAW_CONFIG_PATH
```

Si le fichier est manquant, il utilise des valeurs par défaut (incluant un espace de travail par défaut de `~/.openclaw/workspace`).

### J'ai défini passerellebind lan ou tailnet et maintenant rien n'écoute l'interface utilisateur non autorisé

Les liaisons non-boucle **requièrent l'auth**. Configurer `gateway.auth.mode` + `gateway.auth.token` (ou utiliser `OPENCLAW_GATEWAY_TOKEN`).

```json5
{
  passerelle : {
    bind: "lan",
    auth: {
      mode: "token",
      token: "replace-me",
    },
  },
}
```

Notes :

- `gateway.remote.token` est uniquement pour les **appels CLI distants** ; il n'active pas l'authentification de passerelle locale.
- L'interface de contrôle s'authentifie via `connect.params.auth.token` (stocké dans les paramètres de l'app/UI). Évitez de mettre des jetons dans les URL.

### Pourquoi ai-je besoin d'un jeton sur localhost maintenant

L'assistant génère un jeton de passerelle par défaut (même en boucle) donc les **clients WS locaux doivent s'authentifier**. Cela empêche d'autres processus locaux d'appeler la passerelle. Collez le jeton dans les paramètres de l'interface utilisateur de contrôle (ou la configuration de votre client) pour vous connecter.

Si vous **vraiment** voulez un loopback ouvert, supprimez `gateway.auth` de votre config. Le médecin peut générer un jeton pour vous à tout moment: `docteur openclaw --generate-gateway-token`.

### Dois-je redémarrer après avoir modifié la configuration

La passerelle surveille la configuration et prend en charge le rechargement à chaud :

- `gateway.reload.mode: "hybrid"` (par défaut) : appliquer les changements sûrs, redémarrer pour les changements critiques
- `hot`, `restart`, `off` sont également supportés

### Comment puis-je activer la recherche web et la récupération web

`web_fetch` fonctionne sans clé API. `web_search` requiert une clé Brave Search API
. **Recommandé:** exécutez `openclaw configure --section web` pour le stocker dans
`tools.web.search.apiKey`. Alternative d'environnement : définissez `BRAVE_API_KEY` pour le processus de passerelle
.

```json5
{
  tools: {
    web: {
      search: {
        activé: true,
        apiKey : "BRAVE_API_KEY_ICI",
        maxResults: 5,
      },
      fetch : {
        enabled: true,
      },
    },
  },
}
```

Remarques :

- Si vous utilisez allowlists, ajoutez `web_search`/`web_fetch` ou `group:web`.
- `web_fetch` est activé par défaut (sauf désactivation explicite).
- Les démons lisent les variables env de `~/.openclaw/.env` (ou de l'environnement de service).

Docs : [Web tools](/tools/web).

### Comment faire fonctionner une passerelle centrale avec des travailleurs spécialisés sur tous les appareils

Le motif commun est **une passerelle** (par exemple Raspberry Pi) plus **nodes** et **agents**:

- **Gateway (central):** possède des canaux (Signal/WhatsApp), routage et sessions.
- **Nodes (devices):** Macs/iOS/Android se connectent en tant que périphériques et exposent les outils locaux (`system.run`, `canvas`, `camera`).
- **Agents (travailleurs):** cerveaux/espaces de travail séparés pour des rôles spéciaux (par exemple "Hetzner ops", "Données personnelles").
- **Sous-agents:** l'arrière-plan de l'apparition d'un agent principal lorsque vous voulez un parallélisme.
- **TUI:** se connecter à la passerelle et commuter les agents/sessions.

Docs : [Nodes](/nodes), [Accès à distance](/gateway/remote), [Routage multi-agents](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### Le navigateur OpenClaw peut-il fonctionner sans tête

Oui. C'est une option de configuration :

```json5
{
  browser: { headless: true },
  agents: {
    par défaut : {
      sandbox: { browser: { headless: true } },
    },
  },
}
```

La valeur par défaut est `false` (headful). Headless est plus susceptible de déclencher des vérifications anti-bot sur certains sites. Voir [Browser](/tools/browser).

Headless utilise le **même moteur Chromium** et fonctionne pour la plupart des automatismes (formulaires, clics, gratter, logins). Les principales différences :

- Pas de fenêtre de navigateur visible (utilisez des captures d'écran si vous avez besoin de visuels).
- Certains sites sont plus stricts en ce qui concerne l'automatisation en mode sans tête (CAPTCHA, anti-bot).
  Par exemple, X/Twitter bloque souvent les sessions sans tête.

### Comment utiliser Brave pour le contrôle du navigateur

Définissez `browser.executablePath` sur votre binaire Brave (ou n'importe quel navigateur basé sur Chromium) et redémarrez la passerelle.
Voir les exemples de configuration complets dans [Browser](/tools/browser#use-brave-or-another-chromium-based-browser).

## Passerelles et nœuds distants

### Comment les commandes se propagent entre Telegram la passerelle et les nœuds

Les messages de Telegram sont traités par la **passerelle**. La passerelle exécute l'agent et
seulement alors appelle les nœuds sur le **Gateway WebSocket** quand un outil node est nécessaire:

Telegram → Passerelle → Agent → `node.*` → Noeud → Passerelle → Telegram

Les nœuds ne voient pas le trafic des fournisseurs entrants ; ils ne reçoivent que des appels RPC de nœuds.

### Comment mon agent peut-il accéder à mon ordinateur si la passerelle est hébergée à distance

Réponse courte : **jumeler votre ordinateur en tant que nœud**. La passerelle s'exécute ailleurs, mais elle peut
appeler des outils `node.*` (écran, caméra, système) sur votre machine locale par le biais de la passerelle WebSocket.

Configuration typique :

1. Exécutez la passerelle sur l'hôte permanent (VPS/home server).
2. Mettez l'hôte de la passerelle + votre ordinateur sur le même coup.
3. Assurez-vous que le WS de la passerelle est joignable (tunnel de connexion en réseau ou SSH).
4. Ouvrez l'application macOS localement et connectez-vous en mode **Remote via SSH** (ou direct tailnet)
   pour qu'il puisse s'enregistrer en tant que nœud.
5. Approuver le noeud sur la passerelle :

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Aucun pont TCP séparé n'est requis; les nœuds se connectent à travers la passerelle WebSocket.

Rappel de sécurité: l'appairage d'un nœud macOS permet `system.run` sur cette machine. N’appairez que des appareils de confiance et consultez [Security](/gateway/security).

Docs : [Nodes](/nodes), [Protocole de passerelle](/gateway/protocol), [mode distant macOS](/platforms/mac/remote), [Security](/gateway/security).

### L'échelle de queue est connectée mais je n'ai pas de réponse Ce qui est maintenant

Vérifier les bases :

- La passerelle est en cours d'exécution: `openclaw gateway status`
- Santé de la passerelle: `status openclaw`
- Santé du canal : `status des canaux openclaw`

Puis vérifier l'authentification et le routage :

- Si vous utilisez Tailscale Serve, assurez-vous que `gateway.auth.allowTailscale` est défini correctement.
- Si vous vous connectez via un tunnel SSH, confirmez que le tunnel local est en marche et pointe vers le port droit.
- Confirmez vos listes d'autorisations (DM ou groupe) inclure votre compte.

Docs : [Tailscale](/gateway/tailscale), [Accès à distance](/gateway/remote), [Channels](/channels).

### Deux instances OpenClaw peuvent-elles se parler avec des VPS locaux

Oui. Il n’existe pas de pont « bot‑à‑bot » intégré, mais vous pouvez le mettre en place de plusieurs façons fiables :

**Simplest:** utilise un canal de discussion normal auquel les deux bots peuvent accéder (Telegram/Slack/WhatsApp).
Avoir Bot A envoyer un message à Bot B, puis laisser Bot B répondre comme d'habitude.

**CLI bridge (générique) :** exécute un script qui appelle l'autre passerelle avec
`openclaw agent --message ... --deliver`, ciblant un chat où l'autre bot
écoute. Si un bot est sur un VPS distant, pointez votre CLI à cette passerelle distante
via SSH/Tailscale (voir [Accès à distance](/gateway/remote)).

Modèle d'exemple (exécuté à partir d'une machine qui peut atteindre la passerelle cible):

```bash
openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
```

Astuce : ajoutez un rail de garde pour que les deux bots ne bouclent pas sans fin (mention seule, canal
listes d'autorisations, ou une règle "ne pas répondre aux messages du bot").

Docs : [Accès à distance](/gateway/remote), [Agent CLI](/cli/agent), [Envoi de l'agent](/tools/agent-send).

### Ai-je besoin d'un VPS séparé pour plusieurs agents

Non. Une passerelle peut héberger plusieurs agents, chacun avec son propre espace de travail, les modèles par défaut,
et le routage. C'est la configuration normale et c'est beaucoup moins cher et plus simple que d'exécuter
un VPS par agent.

Utilisez des VPSes séparés uniquement lorsque vous avez besoin d'isolation dure (frontières de sécurité) ou de très
configurations différentes que vous ne voulez pas partager. Sinon, gardez une passerelle et
utiliser plusieurs agents ou sous-agents.

### Y a-t-il un avantage à utiliser un nœud sur mon ordinateur portable personnel au lieu de SSH d'un VPS

Oui — les nœuds sont le moyen de premier ordre pour accéder à votre ordinateur portable depuis un Gateway distant, et ils offrent bien plus qu’un simple accès au shell. La passerelle fonctionne sur macOS/Linux (Windows via WSL2) et est
léger (un petit VPS ou Raspberry Pi-class box est bien; 4 Go de RAM est abondant), donc une configuration
commune est un hôte permanent plus votre ordinateur portable en tant que nœud.

- **Aucun SSH entrant n'est requis.** Les nœuds se connectent à la passerelle WebSocket et utilisent le jumelage de périphériques.
- **Des contrôles d'exécution plus sûrs.** `system.run` est bloqué par des listes d'autorisations/approbations de noeuds sur cet ordinateur portable.
- **Plus d'outils de périphériques.** Nodes expose `canvas`, `camera` et `screen` en plus de `system.run`.
- \*\*Automatisation locale du navigateur. \* Gardez la passerelle sur un VPS, mais exécutez Chrome localement et contrôlez le relais
  avec l'extension Chrome + un hôte de nœud sur l'ordinateur portable.

SSH convient parfaitement pour un accès au shell ad hoc, mais les nœuds sont plus simples pour les workflows d'agents en cours et l'automatisation de périphériques
.

Docs : [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Extension Chrome](/tools/chrome-extension).

### Devrais-je installer sur un second ordinateur portable ou simplement ajouter un nœud

Si vous n’avez besoin que des **outils locaux** (écran/caméra/exec) sur le second ordinateur portable, ajoutez‑le comme **nœud**. Cela garde une seule passerelle et évite la duplication de la configuration. Les outils de noeuds locaux sont
actuellement macOS uniquement, mais nous prévoyons de les étendre à d'autres OS.

Installez une deuxième passerelle uniquement lorsque vous avez besoin de **l'isolation dure** ou de deux robots complètement séparés.

Docs : [Nodes](/nodes), [Nodes CLI](/cli/nodes), [passerelles multiples](/gateway/multiple-gateways).

### Faire exécuter un service de passerelle aux nœuds

Non. **une seule passerelle** devrait être exécutée par hôte à moins que vous n'exécutiez intentionnellement des profils isolés (voir [passerelles multiples](/gateway/multiple-gateways)). Les nœuds sont des périphériques qui connectent
à la passerelle (iOS/Android nodes, ou le "mode noeud" macOS dans l'application de la barre de menu). Pour les hôtes des nœuds
sans tête et le contrôle CLI, voir [CLIC hôte du nœud] (/cli/node).

Un redémarrage complet est nécessaire pour les modifications de `gateway`, `discovery`, et `canvasHost` .

### Y a-t-il une méthode RPC API pour appliquer la configuration

Oui. `config.apply` valide + écrit la configuration complète et redémarre la passerelle dans le cadre de l'opération.

### configapply a effacé ma configuration Comment puis-je récupérer et éviter cela

`config.apply` remplace la **configuration entière**. Si vous envoyez un objet partiel, tout le reste est supprimé.

Récupérer :

- Restaurer à partir d'une sauvegarde (git ou un `~/.openclaw/openclaw.json` copié).
- Si vous n'avez pas de sauvegarde, ré-exécutez `openclaw doctor` et reconfigurez les canaux/modèles.
- Si cela était inattendu, remplissez un bogue et incluez votre dernière configuration connue ou une sauvegarde.
- Un agent de codage local peut souvent reconstruire une configuration fonctionnelle à partir des logs ou de l'historique.

Éviter :

- Utilisez `openclaw config set` pour de petits changements.
- Utilisez `openclaw configure` pour des modifications interactives.

Documents : [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

### Quelle configuration Sane minimale pour une première installation

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Ceci définit votre espace de travail et restreint qui peut déclencher le bot.

### Comment configurer l'échelle de queue sur un VPS et me connecter à partir de mon Mac

Étapes minimales:

1. **Installez + connectez-vous sur le VPS**

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. **Installez + connectez-vous sur votre Mac**
   - Utilisez l'application Tailscale et connectez-vous au même tailnet.

3. **Activer MagicDNS (recommandé)**
   - Dans la console d'administration en échelle de queue, activez MagicDNS pour que le VPS ait un nom stable.

4. **Utilisez le nom d'hôte du réseau tail**
   - SSH: `ssh user@votre-vps.tailnet-xxxx.ts.net`
   - Passerelle WS: `ws://votre-vps.tailnet-xxxx.ts.net:18789`

Si vous voulez l'interface de contrôle sans SSH, utilisez Tailscale Serve sur le VPS :

```bash
openclaw gateway --tailscale serve
```

Cela maintient la passerelle liée au loopback et expose HTTPS via Tailscale. Voir [Tailscale](/gateway/tailscale).

### Comment puis-je connecter un nœud Mac à un serveur en échelle de queue de passerelle distante

Serve expose la **interface de contrôle de passerelle + WS**. Les nœuds se connectent sur le même point de terminaison WS de Gateway.

Configuration recommandée :

1. **Assurez-vous que le VPS + Mac est sur la même queue**.
2. **Utilisez l'application macOS en mode distant** (SSH target can be the tailnet hostname).
   L'application va tunnel le port de la passerelle et se connecter en tant que nœud.
3. **Approuver le nœud** sur la passerelle :

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Docs : [Protocole de passerelle](/gateway/protocol), [Discovery](/gateway/discovery), [mode distant macOS](/platforms/mac/remote).

## Env vars et .env chargement

### Comment les variables d'environnement d'OpenClaw chargent-elles

OpenClaw lit les variables d’environnement depuis le processus parent (shell, launchd/systemd, CI, etc.) et charges supplémentaires:

- `.env` du répertoire de travail actuel
- un repli global `.env` depuis `~/.openclaw/.env` (alias `$OPENCLAW_STATE_DIR/.env`)

Aucun fichier `.env` ne remplace des variables d’environnement existantes.

Vous pouvez également définir des variables env en ligne dans la configuration (appliquées uniquement si elles sont manquantes dans le processus d'envie) :

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

Voir [/environment](/environment) pour la priorité complète et les sources.

### J'ai commencé la passerelle par le service et mes vars env ont disparu ce qui est maintenant

Deux corrections courantes :

1. Mettez les clés manquantes dans `~/.openclaw/.env` afin qu'elles soient ramassées même si le service n'hérite pas votre shell env.
2. Activer l'importation shell (opt-in convenience) :

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

Ceci exécute votre shell de connexion et n'importe que les clés attendues manquantes (jamais remplacées). Env var équivalents :
`OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

### J'ai défini COPILOTGITHUBTOKEN mais le statut des modèles montre l'env Shell de Pourquoi

`openclaw model status` indique si **shell env import** est activé. "Shell env: off"
ne signifie **pas** que vos variables env sont manquantes - cela signifie simplement qu'OpenClaw ne chargera pas
votre shell de connexion automatiquement.

Si la passerelle s'exécute en tant que service (lancement/système), elle n'héritera pas de votre environnement shell
. Corriger en faisant l'un de ces éléments :

1. Mettez le jeton dans `~/.openclaw/.env`:

   ```
   COPILOT_GITHUB_TOKEN=...
   ```

2. Ou activez l'importation du shell (`env.shellEnv.enabled: true`).

3. Ou ajoutez-le à votre bloc `env` de configuration (ne s'applique qu'en cas de manquance).

Puis redémarrez la passerelle et revérifiez :

```bash
openclaw models status
```

Copilot tokens are read from `COPILOT_GITHUB_TOKEN` (also `GH_TOKEN` / `GITHUB_TOKEN`).
Voir [/concepts/model-providers](/concepts/model-providers) et [/environment](/help/environment).

## Sessions et chats multiples

### Comment démarrer une nouvelle conversation

Envoyer `/new` ou `/reset` en tant que message autonome. Voir [Gestion de la session](/concepts/session).

### Faire la réinitialisation automatique des sessions si je n'envoie jamais de nouvelles

Oui. Les sessions expirent après `session.idleMinutes` (par défaut **60**). Le message **suivant**
lance un nouvel identifiant de session pour cette clé. Cela ne supprime pas les transcriptions — cela démarre simplement une nouvelle session.

```json5
{
  session: {
    idleMinutes: 240,
  },
}
```

### Y a-t-il un moyen de faire une équipe d'instances OpenClaw un PDG et de nombreux agents

Oui, via **routage multi-agents** et **sous-agents**. Vous pouvez créer un agent coordinator
et plusieurs agents de travail avec leurs propres espaces de travail et modèles.

Cela dit, c'est mieux vu comme une **expérience amusante**. C'est un jeton lourd et souvent
moins efficace que l'utilisation d'un bot avec des sessions séparées. Le modèle typique que nous
envisageons est un bot avec lequel vous parlez, avec différentes sessions pour le travail parallèle. Ce bot peut également engendrer des sous‑agents si nécessaire.

Docs : [routage multi-agents](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agents CLI](/cli/agents).

### Pourquoi le contexte a-t-il été tronqué en milieu de tâche Comment le prévenir

Le contexte de session est limité par la fenêtre du modèle. Les chats longs, les sorties de gros outils ou de nombreux fichiers
peuvent déclencher la compression ou la tronquage.

Qu'est-ce qui aide :

- Demandez au bot de résumer l'état actuel et de l'écrire dans un fichier.
- Utilisez `/compact` avant de longues tâches, et `/new` lors du changement de thèmes.
- Gardez un contexte important dans l'espace de travail et demandez au bot de le lire.
- Utiliser des sous-agents pour un travail long ou parallèle de sorte que le chat principal reste plus petit.
- Choisissez un modèle avec une fenêtre de contexte plus grande si cela se produit souvent.

### Comment puis-je réinitialiser complètement OpenClaw mais le garder installé

Utilisez la commande reset :

```bash
openclaw reset
```

Réinitialisation complète non interactive :

```bash
openclaw reset --scope full --yes --non-interactive
```

Puis ré-exécuter l'intégration :

```bash
openclaw onboard --install-daemon
```

Notes :

- L'assistant d'intégration offre également **Réinitialiser** s'il voit une configuration existante. Voir [Wizard](/start/wizard).
- Si vous avez utilisé des profils (`--profile` / `OPENCLAW_PROFILE`), réinitialisez chaque dossier d'état (les valeurs par défaut sont `~/.openclaw-<profile>`).
- Réinitialisation Dev : `openclaw gateway --dev --reset` (dev-only; efface dev config + credentials + sessions + workspace).

### Je reçois des erreurs de contexte trop grandes comment puis-je réinitialiser ou compacte

Utilisez l’une de ces options :

- **Compact** (garde la conversation mais résume les anciennes tours):

  ```
  /compacte
  ```

  ou `/compact <instructions>` pour guider le résumé.

- **Réinitialiser** (nouvel ID de session pour la même touche de chat) :

  ```
  /new
  /reset
  ```

Si cela continue de se produire:

- Activer ou affiner le **nettoyage de session** (`agents.defaults.contextPruning`) pour couper la sortie de l'ancien outil.
- Utilisez un modèle avec une fenêtre de contexte plus grande.

Docs : [Compaction](/concepts/compaction), [prunage de la session](/concepts/session-pruning), [Gestion de la session](/concepts/session).

### Pourquoi est-ce que je vois la requête LLM rejetée messages NcontentXtooluseinput Champ requis

Ceci est une erreur de validation du fournisseur : le modèle a émis un bloc `tool_use` sans la
`input` requise. Cela signifie généralement que l'historique de la session est obsolète ou corrompu (souvent après de longs threads
ou un changement d'outil/schéma).

Correction : démarre une nouvelle session avec `/new` (message autonome).

### Pourquoi suis-je victime de coups de cœur toutes les 30 minutes

Les battements cardiaques fonctionnent tous les **30m** par défaut. Ajuster ou désactiver :

```json5
{
  agents: {
    par défaut: {
      heartbeat: {
        every: "2h", // ou "0m" pour désactiver
      },
    },
  },
}
```

Si `HEARTBEAT.md` existe mais est effectivement vide (uniquement des lignes vides et des en-têtes markdown
comme `# Heading`), OpenClaw ignore l’exécution du heartbeat pour économiser des appels API.
Si le fichier est manquant, le heartbeat s’exécute quand même et le modèle décide quoi faire.

Per-agent remplace l'utilisation de `agents.list[].heartbeat`. Docs : [Heartbeat](/gateway/heartbeat).

### Dois-je ajouter un compte bot à un groupe WhatsApp

Non. OpenClaw fonctionne sur **votre propre compte**, donc si vous êtes dans le groupe, OpenClaw peut le voir.
Par défaut, les réponses de groupe sont bloquées jusqu'à ce que vous autorisiez les expéditeurs (`groupPolicy: "allowlist`).

Si vous voulez seulement **vous** être en mesure de déclencher des réponses de groupe:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

### Comment puis-je obtenir le JID d'un groupe WhatsApp

Option 1 (plus rapide) : logs de queue et envoi d'un message de test dans le groupe :

```bash
logs openclaw --follow --json
```

Cherchez `chatId` (ou `from`) se terminant par `@g.us`, comme:
`1234567890-1234567890@g.us`.

Option 2 (si déjà configurée/autorisée) : groupes de liste de config:

```bash
openclaw directory groups list --channel whatsapp
```

Documents : [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

### Pourquoi OpenClaw ne répond pas dans un groupe

Deux causes communes:

- La mention de la barrière est activée (par défaut). Vous devez @mentionner le bot (ou faire correspondre `mentionPatterns`).
- Vous avez configuré `channels.whatsapp.groups` sans `"*"` et le groupe n'est pas autorisé.

Voir [Groups](/channels/groups) et [Messages de groupe] (/channels/group-messages).

### Faire des threads de groupe partager le contexte avec des DMs

Les chats directs se réduisent par défaut à la session principale. Groupes/canaux ont leurs propres clés de session, et les sujets Telegram / Discords sont des sessions séparées. Voir [Groups](/channels/groups) et [Messages de groupe] (/channels/group-messages).

### Combien d'espaces de travail et d'agents puis-je créer

Pas de limites difficiles. Des douzaines (même des centaines) vont bien, mais veillent à ce que :

- **Croissance du disque :** sessions + transcripts live sous `~/.openclaw/agents/<agentId>/sessions/`.
- **Coût du jeton :** plus d'agents signifie plus d'utilisation simultanée du modèle.
- **Opération forte:** profils, espaces de travail et routage des canaux d'authentification par agent.

Conseils :

- Garder un espace de travail **actif** par agent (`agents.defaults.workspace`).
- Supprimez les anciennes sessions (supprimer les entrées JSONL ou de magasin) si le disque grossit.
- Utilisez `openclaw doctor` pour repérer les espaces de travail errants et les incompatibilités de profil.

### Puis-je exécuter plusieurs bots ou chats en même temps Slack et comment dois-je configurer cela

Oui. Utilisez le **routage multi‑agents** pour exécuter plusieurs agents isolés et router les messages entrants par canal/compte/peer. Slack est supporté en tant que canal et peut être lié à des agents spécifiques.

L'accès au navigateur est puissant mais pas "faire quoi que ce soit qu'un humain peut" - l'anti-bot, les CAPTCHA et MFA peuvent
bloquer encore l'automatisation. Pour un contrôle du navigateur le plus fiable, utilisez le relais d'extension de Chrome
sur la machine qui exécute le navigateur (et gardez la passerelle n'importe où).

Configuration des meilleures pratiques :

- Hôte de passerelle permanente (VPS/Mac mini).
- Un agent par rôle (liaisons).
- Canaux(s) Slack liés à ces agents.
- Navigateur local via un relais d'extension (ou un nœud) lorsque nécessaire.

Docs : [Routage multi-agents](/concepts/multi-agent), [Slack](/channels/slack),
[Browser](/tools/browser), [Extension Chrome](/tools/chrome-extension), [Nodes](/nodes).

## Modèles: par défaut, sélection, alias, changement de modèle

### Quel est le modèle par défaut

Le modèle par défaut d'OpenClaw est ce que vous définissez comme :

```
agents.defaults.model.primary
```

Les modèles sont référencés comme `provider/model` (exemple: `anthropic/claude-opus-4-6`). Si vous omettez le fournisseur, OpenClaw assume actuellement `anthropic` comme un repli temporaire de dépréciation - mais vous devriez toujours **explicitement** définir `provider/model`.

### Quel modèle recommandez-vous

**Par défaut recommandé:** `anthropic/claude-opus-4-6`.
**Bonne alternative:** `anthropic/claude-sonnet-4-5`.
**Reliable (moins de caractères):** `openai/gpt-5.2` - presque aussi bonne qu'Opus, juste moins de personnalité.
**Budget:** `zai/glm-4.7`.

MiniMax M2.1 a sa propre documentation : [MiniMax](/providers/minimax) et
[Modèles locals](/gateway/local-models).

Règle de base : utilisez le **meilleur modèle que vous pouvez vous permettre** pour le travail avec des enjeux élevés, et un modèle
moins cher pour le chat de routine ou les résumés. Vous pouvez acheminer les modèles par agent et utiliser les sous-agents vers
paralléliser les tâches longues (chaque sous-agent consomme des jetons). Voir [Models](/concepts/models) et
[Sub-agents](/tools/subagents).

Avertissement fort : les modèles plus faibles ou excessivement quantifiés sont plus vulnérables aux injections de prompt et aux comportements dangereux. Voir [Security](/gateway/security).

Plus de contexte: [Models](/concepts/models).

### Puis-je utiliser des modèles auto-hébergés llamacpp vLLM Ollama

Oui. Si votre serveur local expose une API compatible OpenAI, vous pouvez y pointer un fournisseur personnalisé. Ollama est supporté directement et est le chemin le plus facile.

Note de sécurité�: les modèles plus petits ou fortement quantifiés sont plus vulnérables à l’injection de prompts. Nous recommandons fortement les **grands modèles** pour tout bot qui peut utiliser des outils.
Si vous voulez toujours des petits modèles, activez la boxe à sable et des listes d'autorisations d'outil strictes.

Docs : [Ollama](/providers/ollama), [Modèles locals](/gateway/local-models),
[Fournisseurs de modèles](/concepts/model-providers), [Security](/gateway/security),
[Sandboxing](/gateway/sandboxing).

### Comment changer de modèle sans effacer ma configuration

Utilisez **les commandes de modèles** ou modifiez seulement les champs **model**. Éviter les remplacements de configuration complets.

Options de sécurité:

- `/model` dans le chat (rapide, par session)
- `set de modèles openclaw ...` (mise à jour de la configuration du modèle)
- `openclaw configure --section model` (interactif)
- éditer `agents.defaults.model` dans `~/.openclaw/openclaw.json`

Évitez `config.apply` avec un objet partiel, sauf si vous avez l'intention de remplacer la configuration complète.
Si vous avez écrasé la configuration, restaurez à partir de la sauvegarde ou ré-exécutez `openclaw doctor` pour réparer.

Documents : [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

### Que font OpenClaw, Flawd et Krill pour les modèles

- **OpenClaw + Flawd:** Anthropic Opus (`anthropic/claude-opus-4-6`) - voir [Anthropic](/providers/anthropic).
- **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - see [MiniMax](/providers/minimax).

### Comment puis-je changer de modèle à la volée sans redémarrer

Utilisez la commande `/model` comme message autonome :

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

Vous pouvez lister les modèles disponibles avec `/model`, `/model list`, ou `/model status`.

`/model` (et `/model list`) montre un sélecteur compact, numéroté. Sélectionner par numéro:

```
/modèle 3
```

Vous pouvez également forcer un profil d'authentification spécifique pour le fournisseur (par session) :

```
/model opus@anthropic:default
/model opus@anthropic:work
```

Astuce : `/model status` montre quel agent est actif, quel fichier `auth-profiles.json` est en cours d'utilisation, et quel profil d'authentification sera essayé ensuite.
Il affiche également le endpoint fournisseur configuré (`baseUrl`) et le mode API (`api`) lorsque disponible.

**Comment désépingler un profil que j'ai défini avec le profil**

Ré-exécuter `/model` **sans** le suffixe `@profile` :

```
/fr/model anthropic/claude-opus-4-6
```

Si vous voulez revenir à la valeur par défaut, choisissez-la dans `/model` (ou envoyez `/model <default provider/model>`).
Utilisez `/model status` pour confirmer quel profil d'authentification est actif.

### Puis-je utiliser GPT 5.2 pour les tâches quotidiennes et Codex 5.3 pour le codage

Oui. Définissez un par défaut et changez si nécessaire:

- **Changement rapide (par session):** `/model gpt-5.2` pour les tâches quotidiennes, `/model gpt-5.3-codex` pour le codage.
- **Par défaut + switch:** définissez `agents.defaults.model.primary` à `openai/gpt-5.2`, puis passez à `openai-codex/gpt-5.3-codex` lors du codage (ou inversement).
- **Sous-agents:** acheminer des tâches de codage vers des sous-agents avec un modèle par défaut différent.

Voir [Models](/concepts/models) et [Commandes Slash](/tools/slash-commands).

### Pourquoi est-ce que je vois le modèle n'est pas autorisé et alors aucune réponse

Si `agents.defaults.models` est défini, il devient **allowlist** pour `/model` et n'importe quel remplacement de session
. Choisir un modèle qui n'est pas dans cette liste retourne :

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Cette erreur est retournée **au lieu de** une réponse normale. Correction : ajoute le modèle à
`agents.defaults.models`, supprime la liste d'autorisations, ou sélectionne un modèle dans `/model list`.

### Pourquoi je vois le modèle inconnu minimaxMiniMaxM21

Cela signifie que le **provider n'est pas configuré** (aucune configuration de MiniMax provider ou profil d'authentification
n'a été trouvée), donc le modèle ne peut pas être résolu. Un correctif pour cette détection est
dans **2026.1.12** (non publié au moment de l'écriture).

Fix checklist :

1. Mise à jour vers **2026.1.12** (ou depuis la source `main`), puis redémarrez la passerelle.
2. Assurez-vous que MiniMax est configuré (assistant ou JSON), ou qu'une clé API MiniMax
   existe dans les profils env/auth pour que le fournisseur puisse être injecté.
3. Utilisez l'id exact du modèle (sensible à la casse) : `minimax/MiniMax-M2.1` ou
   `minimax/MiniMax-M2.1-lightning`.
4. Run:

   ```bash
   openclaw models list
   ```

   et choisissez dans la liste (ou `/model list` dans le chat).

Voir [MiniMax](/providers/minimax) et [Models](/concepts/models).

### Puis-je utiliser MiniMax comme valeur par défaut et OpenAI pour des tâches complexes

Oui. Utilisez **MiniMax comme modèle par défaut** et changez de modèle **par session** si nécessaire.
Les replis sont pour les **erreurs**, pas les "tâches dures", donc utilisez `/model` ou un agent séparé.

**Option A : switch par session**

```json5
{
  env: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-... },
  agents: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2. " },
      modèles: {
        "minimax/MiniMax-M2. ": { alias: "minimax" },
        "openai/gpt-5. ": { alias: "gpt" },
      },
    },
  },
}
```

Puis :

```
/modèle gpt
```

**Option B : agents séparés**

- Agent par défaut : MiniMax
- Agent B par défaut : OpenAI
- Router par agent ou utiliser `/agent` pour basculer

Docs : [Models](/concepts/models), [Routage multi-agents](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### Are opus sonnet gpt raccourcis internes

Oui. OpenClaw expédie quelques shorthands par défaut (appliqués uniquement lorsque le modèle existe dans `agents.defaults.models`) :

- `opus` → `anthropique/claude-opus-4-6`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

Si vous définissez votre propre alias avec le même nom, votre valeur gagne.

### Comment définir les alias des raccourcis du modèle

Les alias proviennent de `agents.defaults.models.<modelId>.alias`. Exemple :

```json5
{
  agents: {
    par défaut: {
      model: { primary: "anthropic/claude-opus-4-6" },
      modèles: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "anthropic/claude-sonnet-4-5": { alias: "sonnet" },
        "anthropique/claude-haiku-4-5": { alias: "haiku" },
      },
    },
  },
}
```

Puis `/model sonnet` (ou `/<alias>` quand il est supporté) résout à cet ID de modèle.

### Comment ajouter des modèles d'autres fournisseurs comme OpenRouter ou ZAI

OpenRouter (pay-per-token; plusieurs modèles):

```json5
{
  agents: {
    par défaut: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      modèles: { "openrouter/anthropic/claude-sonnet-4-5": {} },
    },
  },
  env: { OPENROUTER_API_KEY: "sk-or-. ." },
}
```

Z.AI (modèles GLM):

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4. " },
      modèles: { "zai/glm-4. ": {} },
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

Si vous faites référence à un fournisseur/modèle mais que la clé de fournisseur requise est manquante, vous obtiendrez une erreur d'authentification d'exécution (e. . `Aucune clé API trouvée pour le fournisseur "zai"`).

**Aucune clé API trouvée pour le fournisseur après l'ajout d'un nouvel agent**

Cela signifie généralement que le **nouvel agent** a un magasin d'authentification vide. L'authentification est par agent et
stockée dans :

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Options de correction :

- Exécutez `openclaw agents add <id>` et configurez l'authentification pendant l'assistant.
- Ou copiez `auth-profiles.json` de l'agent principal `agentDir` dans le nouvel agent `agentDir`.

Ne réutilisez **pas** `agentDir` entre les agents; cela cause des collisions d'auth/de session.

## Basculement du modèle et "Tous les modèles ont échoué"

### Comment fonctionne le basculement

Failover se produit en deux étapes:

1. **Rotation du profil d'authentification** dans le même fournisseur.
2. **Bascule de modele** vers le modele suivant dans `agents.defaults.model.fallbacks`.

Les temps de récupération s'appliquent aux profils défaillants (backoff exponentiel), de sorte qu'OpenClaw peut continuer à répondre même si un fournisseur est limité à taux ou temporairement défaillant.

### Que signifie cette erreur

```
Aucun identifiant trouvé pour le profil "anthropic:default"
```

Cela signifie que le système a tenté d'utiliser l'identifiant de profil d'authentification `anthropic:default`, mais n'a pas pu trouver d'identifiants pour cela dans le magasin d'authentification attendu.

### Réparer la liste de contrôle pour Aucune information d'identification trouvée pour le profil anthropique par défaut

- **Confirmer où vivent les profils d'authentification** (nouveaux vs chemins existants)
  - Actuellement: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - Legacy: `~/.openclaw/agent/*` (migré par `openclaw doctor`)
- **Confirmez que votre var env est chargé par la passerelle**
  - Si vous définissez `ANTHROPIC_API_KEY` dans votre shell mais que vous exécutez la passerelle via le système/lancement, il se peut qu'elle ne l'hérite. Mettez-le dans `~/.openclaw/.env` ou activez `env.shellEnv`.
- **Assurez-vous de modifier le bon agent**
  - Les configurations multi-agents signifient qu'il peut y avoir plusieurs fichiers `auth-profiles.json`.
- **Etat de l'authentification et du modèle de vérification**
  - Utilisez `l'état des modèles openclaw` pour voir les modèles configurés et si les fournisseurs sont authentifiés.

**Corriger la liste de contrôle pour Aucune information d'identification trouvée pour le profil anthropique**

Cela signifie que la course est épinglée à un profil d'authentification Anthropique, mais que la passerelle
ne peut pas la trouver dans son magasin d'authentification.

- **Utilisez un setup-token**
  - Exécutez `claude setup-token`, puis collez-le avec `openclaw models auth setup-token --provider anthropic`.
  - Si le jeton a été créé sur une autre machine, utilisez `openclaw modèles auth paste-token --provider anthropic`.

- **Si vous voulez utiliser une clé API à la place.**
  - Mettez `ANTHROPIC_API_KEY` dans `~/.openclaw/.env` sur l'**hôte de passerelle**.
  - Effacer tout ordre épinglé qui force un profil manquant :

    ```bash
    L'ordre d'authentification des modèles openclaw --provider anthropique
    ```

- **Confirmez que vous exécutez des commandes sur l'hôte de passerelle**
  - En mode distant, les profils d'authentification sont en direct sur la machine de passerelle, pas sur votre ordinateur portable.

### Pourquoi a-t-il également essayé Google Gemini et a échoué

Si la configuration de votre modèle inclut Google Gemini comme solution de secours (ou si vous avez basculé vers un raccourci Gemin), OpenClaw l'essaiera pendant le repli du modèle. Si vous n'avez pas configuré les identifiants Google, vous verrez `Aucune clé API trouvée pour le fournisseur "google"`.

Correction : soit fournir Google auth, soit supprimer/éviter les modèles Google dans `agents.defaults.model.fallbacks` / alias de sorte que le repli ne se déroule pas là.

**La demande de LLM a rejeté la signature de pensée de message nécessitant l'antigravité de Google**

Cause: l'historique de session contient **des blocs de pensée sans signatures** (souvent de
un flux interrompu/partiel). Google Antigravity a besoin de signatures pour les blocs de pensée.

Correction : OpenClaw supprime maintenant les blocs de pensée non signés pour Google Antigravity Claude. Si cela apparaît toujours, démarrez une **nouvelle session** ou définissez `/thinking off` pour cet agent.

## Profils d'authentification : ce qu'ils sont et comment les gérer

Relatif : [/concepts/oauth](/concepts/oauth) (OAuth flows, token storage, multi-account patterns)

### Qu'est-ce qu'un profil d'authentification

Un profil d'authentification est un enregistrement d'authentification nommé (OAuth ou clé API) lié à un fournisseur. Profils en direct dans:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### Quels sont les identifiants de profil typiques

OpenClaw utilise des identifiants préfixés par le fournisseur comme :

- `anthropic:default` (commun quand aucune identité email n'existe)
- `anthropique :<email>` pour les identités OAuth
- identifiants personnalisés que vous choisissez (par exemple `anthropique:work`)

### Puis-je contrôler quel profil d'authentification est essayé en premier

Oui. La configuration prend en charge les métadonnées facultatives pour les profils et une commande par fournisseur (`auth.order.<provider>`). Ceci **ne stocke pas** les secrets ; il fait correspondre les identifiants au fournisseur/mode et définit l'ordre de rotation.

OpenClaw peut temporairement sauter un profil si c'est dans un court **cooldown** (taux limits/timeouts/auth failures) ou un état **disabled** plus long (facturation/crédits insuffisants). Pour inspecter ceci, exécutez `openclaw models status --json` et vérifiez `auth.unusableProfiles`. Réglage : `auth.cooldowns.billingBackoffHours*`.

Vous pouvez également définir une substitution de commande **par agent** (stockée dans `auth-profiles.json`) de cet agent via le CLI :

```bash
# Par défaut, l'agent par défaut configuré (omit --agent)
l'ordre d'authentification des modèles openclaw get --provider anthropic

# Verrouiller la rotation sur un seul profil (n'essayez que celui-ci)
openclaw modèles auth ordre --provider anthropic:default

# Ou définir un ordre explicite (repli dans le provider)
modèle openclaw auth protocole --provider anthropic:work anthropic:work anthropic:default

# Forcer la substitution (revenir à config auth. rder / rond-robin)
modèles d'authentification openclaw clair --provider anthropique
```

Pour cibler un agent spécifique :

```bash
Protocole d'authentification des modèles openclaw --provider anthropique --agent principal anthropic:default
```

### Clé OAuth vs API quelle est la différence

OpenClaw prend en charge les deux:

- **OAuth** tire souvent parti de l'accès à l'abonnement (le cas échéant).
- Les **clés API** utilisent la facturation pay-per-jeton.

L'assistant supporte explicitement les jetons de configuration Anthropic et OpenAI Codex OAuth et peut stocker les clés API pour vous.

## Passerelle : ports, "déjà en cours d'exécution", et mode distant

### Quel port la passerelle utilise-t-elle

`gateway.port` contrôle le seul port multiplexé pour WebSocket + HTTP (Control UI, hooks, etc.).

Priorite :

```
--port > OPENCLAW_GATEWAY_PORT > gateway.port > default 18789
```

### Pourquoi le statut de la passerelle openclaw dit-il que Runtime est en cours d'exécution mais que la sonde RPC a échoué

Parce que "en cours d'exécution" est la vue **superviseur** (lancement/système/schtasks). La sonde RPC est le CLI se connectant actuellement à la passerelle WebSocket et appelant `status`.

Utilisez `l'état de la passerelle openclaw` et faites confiance à ces lignes:

- `Probe target:` (l'URL que la sonde a réellement utilisée)
- `Écoute:` (ce qui est réellement lié sur le port)
- `Dernière erreur de passerelle :` (cause courante de la racine lorsque le processus est en cours mais que le port n'écoute pas)

### Pourquoi le statut de passerelle openclaw montre-t-il la configuration cli et le service de configuration diffère-t-il

Vous éditez un fichier de configuration alors que le service exécute un autre (souvent une incompatibilité avec `--profile` / `OPENCLAW_STATE_DIR`).

Correctif:

```bash
installation de la passerelle openclaw --force
```

Exécutez cela à partir du même `--profile` / environnement que vous voulez que le service utilise.

### Qu'est-ce qu'une autre instance de passerelle est déjà en écoute moyenne

OpenClaw impose un verrou d'exécution en liant l'écouteur WebSocket immédiatement au démarrage (par défaut `ws://127.0.0.1:18789`). Si le bind échoue avec `EADDRINUSE`, il lance `GatewayLockError` indiquant qu'une autre instance est déjà en train d'écouter.

Correction : arrête l'autre instance, libère le port, ou exécute avec `openclaw gateway --port <port>`.

### Comment faire pour exécuter OpenClaw en mode distant que le client se connecte à une passerelle ailleurs

Définissez `gateway.mode: "remote"` et pointez vers une URL WebSocket distante, éventuellement avec un jeton/mot de passe:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "votre-jeton",
      password: "votre-mot de passe",
    },
  },
}
```

Notes :

- `openclaw gateway` ne démarre que lorsque `gateway.mode` est `local` (ou que vous passez le drapeau de remplacement).
- L'application macOS surveille le fichier de configuration et bascule les modes en temps réel lorsque ces valeurs changent.

### L'interface de contrôle dit non autorisé ou continue de reconnecter ce qui est maintenant

Votre passerelle fonctionne avec l'authentification activée (`gateway.auth.*`), mais l'interface utilisateur n'envoie pas le jeton/mot de passe correspondant.

Faits (à partir du code) :

- L'UI Contrôle stocke le jeton dans la clé localStorage du navigateur `openclaw.control.settings.v1`.

Correctif:

- Rapide: `openclaw dashboard` (affiche + copie l'URL du tableau de bord, essaye de l'ouvrir; affiche l'indice SSH si sans chapeau).
- Si vous n'avez pas encore de jeton : `docteur openclaw --generate-gateway-token`.
- Si distant, le tunnel d'abord : `ssh -N -L 18789:127.0.0.1:18789 user@host` puis ouvrez `http://127.0.0.1:18789/`.
- Définissez `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`) sur l'hôte de la passerelle.
- Dans les paramètres de l’interface de contrôle, collez le même jeton.
- Toujours coincé? Exécutez `openclaw status --all` et suivez [Troubleshooting](/gateway/troubleshooting). Voir [Dashboard](/web/dashboard) pour les détails d'authentification.

### J'ai réglé le gatewaybind tailnet mais il ne peut pas lier d'écoute

`tailnet` bind sélectionne une IP en échelle de queue depuis vos interfaces réseau (100.64.0.0/10). Si la machine n'est pas en Tailscale (ou l'interface est en panne), il n'y a rien à lier.

Correctif:

- Démarrer l'échelle de queue sur cet hôte (donc il a une adresse 100.x), ou
- Basculez vers `gateway.bind: "loopback"` / `"lan"`.

Note: `tailnet` est explicite. `auto` préfère la boucle; utilisez `gateway.bind: "tailnet"` quand vous voulez une liaison avec uniquement tailnet.

### Puis-je exécuter plusieurs passerelles sur le même hôte

Habituellement pas - une passerelle unique peut exécuter plusieurs canaux de messagerie et des agents. Utilisez plusieurs passerelles uniquement lorsque vous avez besoin d'une redondance (ex: robot de sauvetage) ou d'une isolation dure.

Oui, mais vous devez isoler :

- `OPENCLAW_CONFIG_PATH` (configuration par instance)
- `OPENCLAW_STATE_DIR` (état par instance)
- `agents.defaults.workspace` (isolement de l'espace de travail)
- `gateway.port` (ports uniques)

Configuration rapide (recommandée) :

- Utilisez `openclaw --profile <name> …` par instance (crée automatiquement `~/.openclaw-<name>`).
- Définissez un `gateway.port` unique dans chaque configuration de profil (ou passez `--port` pour les exécutions manuelles).
- Install a per-profile service: `openclaw --profile <name> gateway install`.

Les profils suffixent également les noms de services (`bot.molt.<profile>`; legacy `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).
Guide complet : [Multiple gateways](/gateway/multiple-gateways).

### Que signifie le code d'établissement de liaison 1008 invalide

La passerelle est un **serveur WebSocket**, et elle attend que le tout premier message à
soit une image `connect`. S'il reçoit autre chose, il ferme la connexion
avec **code 1008** (violation de la politique).

Causes courantes :

- Vous avez ouvert l'URL **HTTP** dans un navigateur (`http://...`) au lieu d'un client WS.
- Vous avez utilisé le mauvais port ou chemin.
- Un mandataire ou un tunnel a supprimé les en-têtes d'authentification ou a envoyé une requête non passerelle.

Corrections rapides :

1. Utilisez l'URL WS: `ws://<host>:18789` (ou `wss://...` si HTTPS).
2. Ne pas ouvrir le port WS dans un onglet normal.
3. Si l'authentification est activée, incluez le jeton/mot de passe dans le cadre `connect`.

Si vous utilisez le CLI ou TUI, l'URL devrait ressembler à :

```
openclaw tui --url ws://<host>:18789 --token <token>
```

Détails du protocole : [Protocole de la Gateway](/gateway/protocol).

## Journalisation et débogage

### Où sont les logs

Journaux des fichiers (structurés) :

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Vous pouvez définir un chemin stable via `logging.file`. Le niveau du journal des fichiers est contrôlé par `logging.level`. La verbosité de la console est contrôlée par `--verbose` et `logging.consoleLevel`.

Queue de journal la plus rapide :

```bash
openclaw logs --follow
```

Journaux du service/superviseur (lorsque la passerelle s'exécute via le lancement/système) :

- macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` et `gateway.err.log` (par défaut: `~/.openclaw/logs/...`; les profils utilisent `~/.openclaw-<profile>/logs/...`)
- Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

Voir [Dépannage](/gateway/troubleshooting#log-locations) pour plus d’informations.

### Comment démarrer le service de passerelle

Utilisez les aides de passerelle :

```bash
statut de la passerelle openclaw
redémarrage de la passerelle openclaw
```

Si vous exécutez la passerelle manuellement, `openclaw gateway --force` peut récupérer le port. Voir [Gateway](/gateway).

### J'ai fermé mon terminal sous Windows comment puis-je redémarrer OpenClaw

Il y a **deux modes d'installation de Windows**:

**1) WSL2 (recommandé):** la passerelle fonctionne à l'intérieur de Linux.

Ouvrez PowerShell, entrez WSL, puis redémarrez :

```powershell
wsl
status de la passerelle openclaw
redémarrage de la passerelle openclaw
```

Si vous n'avez jamais installé le service, démarrez-le au premier plan:

```bash
openclaw gateway run
```

**2) Windows natif (non recommandé):** La passerelle s'exécute directement dans Windows.

Ouvrir PowerShell et exécuter :

```powershell
statut de la passerelle openclaw
redémarrage de la passerelle openclaw
```

Si vous l'exécutez manuellement (sans service), utilisez :

```powershell
openclaw gateway run
```

Documents : [Windows (WSL2)](/platforms/windows), [Livret de service de passerelle](/gateway).

### La passerelle est en place, mais les réponses n'arrivent jamais. Que dois-je vérifier

Commencez par un balayage rapide de santé:

```bash
openclaw status
openclaw modèle l'état
canaux openclaw statut
logs openclaw --follow
```

Causes courantes :

- L'authentification du modèle n'est pas chargée sur l'**hôte de passerelle** (vérifiez le `statut des modèles`).
- Réponses de blocage de l'appairage des canaux/listes de blocage (vérifiez la configuration des canaux + les logs).
- WebChat/Dashboard est ouvert sans le jeton droit.

Si vous êtes à distance, confirmez que la connexion entre tunnel/échelle de queue est en cours et que la WebSocket de passerelle
est joignable.

Documents : [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Accès à distance](/gateway/remote).

### Déconnecté de la passerelle, aucune raison ce qui est maintenant

Cela signifie généralement que l'interface utilisateur a perdu la connexion WebSocket. Verifiez :

1. La passerelle est-elle en cours d'exécution ? `openclaw gateway status`
2. La passerelle est-elle en bonne santé ? `openclaw status`
3. L'interface utilisateur dispose-t-elle du bon jeton ? `openclaw dashboard`
4. Si la télécommande, est-ce que le tunnel/échelle de queue est en haut?

Puis les logs de queue:

```bash
openclaw logs --follow
```

Docs : [Dashboard](/web/dashboard), [Accès à distance](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

### Telegram setMyCommands échoue avec des erreurs de réseau Que dois-je vérifier

Commencer avec les logs et le statut du canal :

```bash
statut des canaux openclaw
openclaw channels logs --channel telegram
```

Si vous êtes sur un VPS ou derrière un proxy, confirmez que HTTPS sortant est autorisé et que le DNS fonctionne.
Si la passerelle est distante, assurez-vous que vous regardez les logs sur l'hôte de la passerelle.

Docs : [Telegram](/channels/telegram), [dépannage de canal](/channels/troubleshooting).

### TUI ne montre aucune sortie que je devrais vérifier

Tout d'abord confirmer que la passerelle est joignable et que l'agent peut exécuter :

```bash
openclaw status
openclaw modèle l'état
logs openclaw --follow
```

Dans le TUI, utilisez `/status` pour voir l'état actuel. Si vous attendez des réponses dans un canal de chat
, assurez-vous que la livraison est activée (`/deliver on`).

Docs : [TUI](/web/tui), [Commandes Slash](/tools/slash-commands).

### Comment puis-je arrêter complètement puis démarrer la passerelle

Si vous avez installé le service:

```bash
arrêt de la passerelle openclaw
démarrage de la passerelle openclaw
```

Ceci arrête/démarre le **service supervisé** (lancement sur macOS, systemd sur Linux).
À utiliser lorsque la passerelle s'exécute en arrière-plan en tant que démon.

Si vous exécutez au premier plan, arrêtez avec Ctrl-C, alors:

```bash
openclaw gateway run
```

Docs: [Gateway service runbook](/gateway).

### Redémarrage de la passerelle ELI5 openclaw vs passerelle openclaw

- `openclaw gateway restart`: redémarre le **service d'arrière-plan** (launchd/systemd).
- `passerelle openclaw`: exécute la passerelle **au premier plan** pour cette session de terminal.

Si vous avez installé le service, utilisez les commandes de passerelle. Utilisez `la passerelle openclaw` quand
vous voulez une exécution unique, au premier plan.

### Quel est le moyen le plus rapide d'obtenir plus de détails lorsque quelque chose échoue

Démarrez la passerelle avec `--verbose` pour obtenir plus de détails sur la console. Ensuite, inspectez le fichier journal pour trouver l'authentification du canal, le routage du modèle et les erreurs RPC.

## Médias et pièces jointes

### Ma compétence a généré une image PDF mais rien n'a été envoyé

Les pièces jointes sortantes de l'agent doivent inclure une ligne `MEDIA:<path-or-url>` (à sa propre ligne). Voir [Configuration de l'assistant OpenClaw](/start/openclaw) et [Envoi de l'agent](/tools/agent-send).

Envoi de CLI :

```bash
message openclaw send --target +155550123 --message "Here you go" --media /path/to/file.png
```

Vérifier aussi:

- Le canal cible prend en charge les médias sortants et n'est pas bloqué par les listes d'autorisations.
- Le fichier est dans les limites de taille du fournisseur (les images sont redimensionnées à 2048px).

Voir [Images](/nodes/images).

## Contrôle de sécurité et d'accès

### Est-il sécuritaire d'exposer OpenClaw aux DMs entrants

Traiter les DMs entrants comme une entrée non approuvée. Les défauts sont conçus pour réduire le risque :

- Le comportement par défaut sur les canaux compatibles avec le DM est **appairage**:
  - Les expéditeurs inconnus reçoivent un code d'appairage ; le bot ne traite pas leur message.
  - Approuver avec: `l'appairage openclaw approuve <channel> <code>`
  - Les requêtes en attente sont plafonnées à **3 par canal**; vérifiez `openclaw pairing list <channel>` si un code n'est pas arrivé.
- L'ouverture des DMs nécessite un opt-in explicite (`dmPolicy: "open"` et allowlist `"*"`).

Exécutez `openclaw doctor` pour les politiques de gestion des risques de surfaces.

### Est l'injection de prompt seulement une préoccupation pour les robots publics

Non. L'injection de message concerne le **contenu non approuvé**, et pas seulement celui qui peut gérer le bot.
Si votre assistant lit le contenu externe (recherche / recherche web, pages de navigateur, e-mails, docs
, pièces jointes, journaux collés), que le contenu peut inclure des instructions qui essayent
de détourner le modèle. Cela peut se produire même si **vous êtes le seul expéditeur**.

Le plus grand risque est quand les outils sont activés : le modèle peut être trompé dans le contexte
en exfiltrant ou en appelant des outils en votre nom. Réduisez le rayon d’action en :

- en utilisant un agent "reader" en lecture seule ou désactivé par l'outil pour résumer le contenu non approuvé
- Garder `web_search` / `web_fetch` / `browser` à l'abri des agents activés par les outils
- sandboxing et outils stricts listes d'autorisations

Détails: [Security](/gateway/security).

### Si mon bot a son propre compte GitHub ou son propre numéro de téléphone

Oui, pour la plupart des configurations. Isoler le bot avec des comptes distincts et des numéros de téléphone
réduit le rayon de projection si quelque chose se passe mal. Cela facilite également la rotation des identifiants
ou la révocation de l'accès sans affecter vos comptes personnels.

Commencer petit. Donner accès uniquement aux outils et comptes dont vous avez réellement besoin, et étendre
plus tard si nécessaire.

Documents : [Security](/gateway/security), [Pairing](/channels/pairing).

### Puis-je lui donner une autonomie par rapport à mes messages textuels et est-ce sûr

Nous ne recommandons **pas** une autonomie totale sur vos messages personnels. Le modèle le plus sûr est :

- Garder les MP en **mode appairage** ou dans une liste d'autorisations serrée.
- Utilisez un **numéro séparé ou compte** si vous voulez qu'il message en votre nom.
- Laissez-le brouiller, puis **approuver avant d'envoyer**.

Si vous voulez expérimenter, faites-le sur un compte dédié et gardez-le isolé. Voir
[Security](/gateway/security).

### Puis-je utiliser des modèles moins chers pour des tâches personnelles d'assistant

Oui, **si** l'agent est en chat seul et l'entrée est fiable. Les niveaux plus petits sont plus sensibles au détournement d’instructions�; évitez-les donc pour les agents utilisant des outils ou lors de la lecture de contenu non fiable. Si vous devez utiliser un modèle plus petit, verrouillez les outils
et exécutez à l'intérieur d'un bac à sable. Voir [Security](/gateway/security).

### J'ai commencé dans Telegram mais je n'ai pas obtenu de code d'appairage

Les codes d'appairage sont envoyés **seulement** lorsqu'un expéditeur inconnu envoie des messages au bot et à
`dmPolicy: "appairage"` est activé. `/start` lui-même ne génère pas de code.

Vérifier les demandes en attente :

```bash
openclaw pairing list telegram
```

Si vous voulez un accès immédiat, autorisez votre identifiant d'expéditeur ou définissez `dmPolicy: "open"`
pour ce compte.

### WhatsApp va envoyer un message à mes contacts Comment fonctionne l'appairage

Non. La politique par défaut du DM WhatsApp **appairage**. Les expéditeurs inconnus ne reçoivent qu'un code d'appairage et leur message n'est **pas traité**. OpenClaw ne répond que pour les conversations reçues ou explicitement vous envoie des déclencheurs.

Approuver l'appairage avec :

```bash
L'appairage openclaw approuve whatsapp <code>
```

Liste des demandes en attente :

```bash
liste d'appairage openclaw whatsapp
```

Assistant invite de numéro de téléphone: il est utilisé pour définir votre **liste d'autorisations/propriétaires** afin que vos propres DMs soient autorisés. Il n'est pas utilisé pour l'envoi automatique. Si vous utilisez votre numéro WhatsApp personnel, utilisez ce numéro et activez `channels.whatsapp.selfChatMode`.

## Commandes de chat, abandon des tâches, et "ça ne s'arrêtera pas"

### Comment empêcher les messages internes du système de s'afficher dans le chat

La plupart des messages internes ou de l'outil n'apparaissent que lorsque **verbose** ou **raisonment** est activé
pour cette session.

Corrige dans le chat où vous le voyez :

```
/verbose off
/reasoning off
```

Si c'est encore bruyant, vérifiez les paramètres de la session dans l'interface de contrôle et définissez
en **héritage**. Confirmez également que vous n'utilisez pas de profil de bot avec `verboseDefault` définir
à `on` dans la configuration.

Docs : [Thinking and verbose](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).

### Comment arrêter une tâche en cours d'exécution

Envoyer l'un de ces **comme un message autonome** (sans slash):

```
arrêter
abandonner
esc
attendre
sortie
interrupt
```

Ce sont des déclencheurs d'abandon (pas des commandes slash).

Pour les processus en arrière-plan (à partir de l'outil exec), vous pouvez demander à l'agent d'exécuter :

```
action de traitement:kill sessionId:XXX
```

Aperçu des commandes de type Tlash : voir [Commandes Slash](/tools/slash-commands).

La plupart des commandes doivent être envoyées en tant que message **standalone** qui commence par `/`, mais quelques raccourcis (comme `/status`) fonctionnent également en ligne pour les expéditeurs autorisés.

### Comment envoyer un message Discord depuis la messagerie Crosscontext de Telegram refusée

OpenClaw bloque la messagerie **cross-provider** par défaut. Si un appel d'outil est lié à
à Telegram, il ne sera envoyé à Discord que si vous l'autorisez explicitement.

Activer la messagerie inter-fournisseur pour l'agent:

```json5
{
  agents: {
    par défaut: {
      tools: {
        message: {
          crossContext: {
            allowAcrossProviders: true, Marqueur
            : { activé: vrai, préfixe : "[de {channel}] " },
          },
        },
      },
    },
  },
}
```

Redémarrez la passerelle après l'édition de la configuration. Si vous voulez seulement cela pour un seul agent
, définissez-le dans `agents.list[].tools.message` à la place.

### Pourquoi est-ce que le bot ignore les messages rapidfire

Le mode file d'attente contrôle l'interaction des nouveaux messages avec une exécution en vol. Utilisez `/queue` pour changer de modes:

- `steer` - les nouveaux messages redirigent la tâche actuelle
- `followup` - lance un message à la fois
- `collect` - envoi de messages par lots et réponse une fois (par défaut)
- `steer-backlog` - orientez maintenant, puis traitez le backlog
- `interrupt` - interrompre l'exécution en cours et démarrer le nouveau

Vous pouvez ajouter des options comme `debounce:2s cap:25 drop:sumize` pour les modes de suivi.

## Répondre à la question exacte de la capture d'écran/journal de chat

**Q : "Quel est le modèle par défaut pour Anthropic avec une clé API ?"**

**R:** Dans OpenClaw, les références et la sélection de modèles sont séparées. Définir `ANTHROPIC_API_KEY` (ou stocker une clé d'API Anthropic dans les profils d'authentification) permet l'authentification, mais le modèle par défaut est ce que vous configurez dans `agents. efaults.model.primary` (par exemple, `anthropic/claude-sonnet-4-5` ou `anthropic/claude-opus-4-6`). Si vous voyez `Aucune identification trouvée pour le profil "anthropic:default"`, cela signifie que la passerelle ne peut pas trouver d'identifiants anthropiques dans les `auth-profiles attendus. son` pour l'agent en cours d'exécution.

---

Toujours coincé? Demandez dans [Discord](https://discord.com/invite/clawd) ou ouvrez une [discussion GitHub] (https://github.com/openclaw/openclaw/discussions).
