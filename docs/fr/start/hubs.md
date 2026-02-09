---
summary: "Des hubs qui renvoient vers toute la documentation OpenClaw"
read_when:
  - Vous voulez une cartographie complete de la documentation
title: "Hubs de documentation"
---

# Hubs de documentation

<Note>
Si vous debutez avec OpenClaw, commencez par [Premiers pas](/start/getting-started).
</Note>

Utilisez ces hubs pour decouvrir chaque page, y compris les analyses approfondies et les documents de reference qui n’apparaissent pas dans la navigation de gauche.

## Commencer ici

- [Index](/)
- [Premiers pas](/start/getting-started)
- [Demarrage rapide](/start/quickstart)
- [Prise en main](/start/onboarding)
- [Assistant](/start/wizard)
- [Configuration initiale](/start/setup)
- [Tableau de bord (Gateway (passerelle) local)](http://127.0.0.1:18789/)
- [Aide](/help)
- [Repertoire de documentation](/start/docs-directory)
- [Configuration](/gateway/configuration)
- [Exemples de configuration](/gateway/configuration-examples)
- [Assistant OpenClaw](/start/openclaw)
- [Vitrine](/start/showcase)
- [Lore](/start/lore)

## Installation + mises a jour

- [Docker](/install/docker)
- [Nix](/install/nix)
- [Mise a jour / retour en arriere](/install/updating)
- [Workflow Bun (experimental)](/install/bun)

## Concepts fondamentaux

- [Architecture](/concepts/architecture)
- [Fonctionnalites](/concepts/features)
- [Hub reseau](/network)
- [Runtime d’agent](/concepts/agent)
- [Espace de travail de l’agent](/concepts/agent-workspace)
- [Memoire](/concepts/memory)
- [Boucle d’agent](/concepts/agent-loop)
- [Streaming + decoupage](/concepts/streaming)
- [Routage multi-agent](/concepts/multi-agent)
- [Compaction](/concepts/compaction)
- [Sessions](/concepts/session)
- [Sessions (alias)](/concepts/sessions)
- [Elagage des sessions](/concepts/session-pruning)
- [Outils de session](/concepts/session-tool)
- [File d’attente](/concepts/queue)
- [Commandes slash](/tools/slash-commands)
- [Adaptateurs RPC](/reference/rpc)
- [Schemas TypeBox](/concepts/typebox)
- [Gestion des fuseaux horaires](/concepts/timezone)
- [Presence](/concepts/presence)
- [Decouverte + transports](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
- [Routage des canaux](/concepts/channel-routing)
- [Groupes](/concepts/groups)
- [Messages de groupe](/concepts/group-messages)
- [Basculement de modele](/concepts/model-failover)
- [OAuth](/concepts/oauth)

## Fournisseurs + ingress

- [Hub des canaux de chat](/channels)
- [Hub des fournisseurs de modeles](/providers/models)
- [WhatsApp](/channels/whatsapp)
- [Telegram](/channels/telegram)
- [Telegram (notes grammY)](/channels/grammy)
- [Slack](/channels/slack)
- [Discord](/channels/discord)
- [Mattermost](/channels/mattermost) (plugin)
- [Signal](/channels/signal)
- [BlueBubbles (iMessage)](/channels/bluebubbles)
- [iMessage (legacy)](/channels/imessage)
- [Analyse de localisation](/channels/location)
- [WebChat](/web/webchat)
- [Webhooks](/automation/webhook)
- [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gateway + operations

- [Runbook du Gateway (passerelle)](/gateway)
- [Modele reseau](/gateway/network-model)
- [Appairage du Gateway (passerelle)](/gateway/pairing)
- [Verrou du Gateway (passerelle)](/gateway/gateway-lock)
- [Processus en arriere-plan](/gateway/background-process)
- [Sante](/gateway/health)
- [Heartbeat](/gateway/heartbeat)
- [Doctor](/gateway/doctor)
- [Journalisation](/gateway/logging)
- [Sandboxing](/gateway/sandboxing)
- [Tableau de bord](/web/dashboard)
- [Interface de controle](/web/control-ui)
- [Acces a distance](/gateway/remote)
- [README du gateway distant](/gateway/remote-gateway-readme)
- [Tailscale](/gateway/tailscale)
- [Securite](/gateway/security)
- [Depannage](/gateway/troubleshooting)

## Outils + automatisation

- [Surface des outils](/tools)
- [OpenProse](/prose)
- [Reference CLI](/cli)
- [Outil Exec](/tools/exec)
- [Mode eleve](/tools/elevated)
- [Taches Cron](/automation/cron-jobs)
- [Cron vs Heartbeat](/automation/cron-vs-heartbeat)
- [Thinking + verbeux](/tools/thinking)
- [Modeles](/concepts/models)
- [Sous-agents](/tools/subagents)
- [CLI d’envoi d’agent](/tools/agent-send)
- [Interface terminal](/tui)
- [Controle du navigateur](/tools/browser)
- [Navigateur (depannage Linux)](/tools/browser-linux-troubleshooting)
- [Sondages](/automation/poll)

## Nœuds, media, voix

- [Apercu des nœuds](/nodes)
- [Camera](/nodes/camera)
- [Images](/nodes/images)
- [Audio](/nodes/audio)
- [Commande de localisation](/nodes/location-command)
- [Reveil vocal](/nodes/voicewake)
- [Mode conversation](/nodes/talk)

## Plateformes

- [Apercu des plateformes](/platforms)
- [macOS](/platforms/macos)
- [iOS](/platforms/ios)
- [Android](/platforms/android)
- [Windows (WSL2)](/platforms/windows)
- [Linux](/platforms/linux)
- [Surfaces Web](/web)

## Application compagnon macOS (avance)

- [Configuration de developpement macOS](/platforms/mac/dev-setup)
- [Barre de menus macOS](/platforms/mac/menu-bar)
- [Reveil vocal macOS](/platforms/mac/voicewake)
- [Superposition vocale macOS](/platforms/mac/voice-overlay)
- [WebChat macOS](/platforms/mac/webchat)
- [Canvas macOS](/platforms/mac/canvas)
- [Processus enfant macOS](/platforms/mac/child-process)
- [Sante macOS](/platforms/mac/health)
- [Icone macOS](/platforms/mac/icon)
- [Journalisation macOS](/platforms/mac/logging)
- [Autorisations macOS](/platforms/mac/permissions)
- [Acces a distance macOS](/platforms/mac/remote)
- [Signature macOS](/platforms/mac/signing)
- [Version macOS](/platforms/mac/release)
- [Gateway macOS (launchd)](/platforms/mac/bundled-gateway)
- [XPC macOS](/platforms/mac/xpc)
- [Skills macOS](/platforms/mac/skills)
- [Peekaboo macOS](/platforms/mac/peekaboo)

## Espace de travail + modeles

- [Skills](/tools/skills)
- [ClawHub](/tools/clawhub)
- [Configuration des Skills](/tools/skills-config)
- [AGENTS par defaut](/reference/AGENTS.default)
- [Modeles : AGENTS](/reference/templates/AGENTS)
- [Modeles : BOOTSTRAP](/reference/templates/BOOTSTRAP)
- [Modeles : HEARTBEAT](/reference/templates/HEARTBEAT)
- [Modeles : IDENTITY](/reference/templates/IDENTITY)
- [Modeles : SOUL](/reference/templates/SOUL)
- [Modeles : TOOLS](/reference/templates/TOOLS)
- [Modeles : USER](/reference/templates/USER)

## Experiences (exploratoires)

- [Protocole de configuration de la prise en main](/experiments/onboarding-config-protocol)
- [Notes de durcissement Cron](/experiments/plans/cron-add-hardening)
- [Notes de durcissement des politiques de groupe](/experiments/plans/group-policy-hardening)
- [Recherche : memoire](/experiments/research/memory)
- [Exploration de la configuration des modeles](/experiments/proposals/model-config)

## Projet

- [Credits](/reference/credits)

## Tests + version

- [Tests](/reference/test)
- [Checklist de publication](/reference/RELEASING)
- [Modeles d’appareils](/reference/device-models)
