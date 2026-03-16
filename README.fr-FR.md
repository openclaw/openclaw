# 🦞 OpenClaw — Assistant IA Personnel

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.png">
        <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.png" alt="OpenClaw" width="500">
    </picture>
</p>

<p align="center">
  <strong>EXFOLIEZ ! EXFOLIEZ !</strong>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="Statut CI"></a>
  <a href="https://github.com/openclaw/openclaw/releases"><img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="Version GitHub"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="Licence MIT"></a>
</p>

**OpenClaw** est un _assistant IA personnel_ que vous hébergez sur vos propres appareils.
Il vous répond sur les canaux que vous utilisez déjà (WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, Microsoft Teams, WebChat), ainsi que sur des canaux d'extension comme BlueBubbles, Matrix, Zalo et Zalo Personal. Il peut parler et écouter sur macOS/iOS/Android, et peut afficher un Canvas interactif que vous contrôlez. La Passerelle n'est que le plan de contrôle — le véritable produit, c'est l'assistant.

Si vous voulez un assistant personnel mono-utilisateur qui soit local, rapide et toujours disponible, vous êtes au bon endroit.

[Site web](https://openclaw.ai) · [Documentation](https://docs.openclaw.ai) · [DeepWiki](https://deepwiki.com/openclaw/openclaw) · [Premiers pas](https://docs.openclaw.ai/start/getting-started) · [Mise à jour](https://docs.openclaw.ai/install/updating) · [Vitrine](https://docs.openclaw.ai/start/showcase) · [FAQ](https://docs.openclaw.ai/start/faq) · [Assistant](https://docs.openclaw.ai/start/wizard) · [Nix](https://github.com/openclaw/nix-openclaw) · [Docker](https://docs.openclaw.ai/install/docker) · [Discord](https://discord.gg/clawd)

Configuration recommandée : lancez l'assistant de configuration (`openclaw onboard`) dans votre terminal.
L'assistant vous guide pas à pas dans la configuration de la passerelle, de l'espace de travail, des canaux et des compétences. L'assistant CLI est la méthode recommandée et fonctionne sur **macOS, Linux et Windows (via WSL2 ; fortement recommandé)**.
Fonctionne avec npm, pnpm ou bun.
Nouvelle installation ? Commencez ici : [Premiers pas](https://docs.openclaw.ai/start/getting-started)

**Abonnements (OAuth) :**

- **[Anthropic](https://www.anthropic.com/)** (Claude Pro/Max)
- **[OpenAI](https://openai.com/)** (ChatGPT/Codex)

Note sur les modèles : bien que n'importe quel modèle soit pris en charge, je recommande vivement **Anthropic Pro/Max (100/200) + Opus 4.6** pour sa capacité de contexte étendu et sa meilleure résistance à l'injection de prompts. Voir [Configuration initiale](https://docs.openclaw.ai/start/onboarding).

## Modèles (sélection + authentification)

- Configuration des modèles + CLI : [Modèles](https://docs.openclaw.ai/concepts/models)
- Rotation des profils d'authentification (OAuth vs clés API) + solutions de secours : [Basculement de modèle](https://docs.openclaw.ai/concepts/model-failover)

## Installation (recommandée)

Runtime : **Node ≥22**.

```bash
npm install -g openclaw@latest
# ou : pnpm add -g openclaw@latest

openclaw onboard --install-daemon
```

L'assistant installe le démon de la Passerelle (service utilisateur launchd/systemd) pour qu'il reste actif en permanence.

## Démarrage rapide (TL;DR)

Runtime : **Node ≥22**.

Guide complet pour débutants (auth, appairage, canaux) : [Premiers pas](https://docs.openclaw.ai/start/getting-started)

```bash
openclaw onboard --install-daemon

openclaw gateway --port 18789 --verbose

# Envoyer un message
openclaw message send --to +1234567890 --message "Bonjour depuis OpenClaw"

# Parler à l'assistant (avec retour optionnel vers n'importe quel canal connecté : WhatsApp/Telegram/Slack/Discord/Google Chat/Signal/iMessage/BlueBubbles/Microsoft Teams/Matrix/Zalo/Zalo Personal/WebChat)
openclaw agent --message "Liste de vérification" --thinking high
```

Mise à niveau ? [Guide de mise à jour](https://docs.openclaw.ai/install/updating) (et lancez `openclaw doctor`).

## Canaux de développement

- **stable** : versions taguées (`vYYYY.M.D` ou `vYYYY.M.D-<patch>`), dist-tag npm `latest`.
- **beta** : tags de préversion (`vYYYY.M.D-beta.N`), dist-tag npm `beta` (l'app macOS peut être absente).
- **dev** : tête mobile de `main`, dist-tag npm `dev` (lorsque publié).

Changer de canal (git + npm) : `openclaw update --channel stable|beta|dev`.
Détails : [Canaux de développement](https://docs.openclaw.ai/install/development-channels).

## Depuis les sources (développement)

Privilégiez `pnpm` pour les builds depuis les sources. Bun est optionnel pour exécuter TypeScript directement.

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw

pnpm install
pnpm ui:build # installe automatiquement les dépendances UI au premier lancement
pnpm build

pnpm openclaw onboard --install-daemon

# Boucle de développement (rechargement automatique des changements TS)
pnpm gateway:watch
```

Note : `pnpm openclaw ...` exécute TypeScript directement (via `tsx`). `pnpm build` produit `dist/` pour exécution via Node / le binaire packagé `openclaw`.

## Paramètres de sécurité par défaut (accès DM)

OpenClaw se connecte à de vraies surfaces de messagerie. Traitez les DM entrants comme des **entrées non fiables**.

Guide de sécurité complet : [Sécurité](https://docs.openclaw.ai/gateway/security)

Comportement par défaut sur Telegram/WhatsApp/Signal/iMessage/Microsoft Teams/Discord/Google Chat/Slack :

- **Appairage DM** (`dmPolicy="pairing"` / `channels.discord.dmPolicy="pairing"` / `channels.slack.dmPolicy="pairing"` ; ancien : `channels.discord.dm.policy`, `channels.slack.dm.policy`) : les expéditeurs inconnus reçoivent un court code d'appairage et le bot ne traite pas leur message.
- Approuver avec : `openclaw pairing approve <canal> <code>` (ensuite l'expéditeur est ajouté à une liste blanche locale).
- Les DM publics entrants nécessitent une activation explicite : définissez `dmPolicy="open"` et incluez `"*"` dans la liste blanche du canal (`allowFrom` / `channels.discord.allowFrom` / `channels.slack.allowFrom` ; ancien : `channels.discord.dm.allowFrom`, `channels.slack.dm.allowFrom`).

Lancez `openclaw doctor` pour identifier les politiques DM risquées ou mal configurées.

## Points forts

- **[Passerelle locale d'abord](https://docs.openclaw.ai/gateway)** — plan de contrôle unique pour les sessions, canaux, outils et événements.
- **[Boîte de réception multi-canaux](https://docs.openclaw.ai/channels)** — WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, BlueBubbles (iMessage), iMessage (ancien), Microsoft Teams, Matrix, Zalo, Zalo Personal, WebChat, macOS, iOS/Android.
- **[Routage multi-agents](https://docs.openclaw.ai/gateway/configuration)** — acheminez les canaux/comptes/pairs entrants vers des agents isolés (espaces de travail + sessions par agent).
- **[Voice Wake](https://docs.openclaw.ai/nodes/voicewake) + [Mode Talk](https://docs.openclaw.ai/nodes/talk)** — reconnaissance vocale toujours active pour macOS/iOS/Android avec ElevenLabs.
- **[Canvas en direct](https://docs.openclaw.ai/platforms/mac/canvas)** — espace de travail visuel piloté par l'agent avec [A2UI](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui).
- **[Outils de première classe](https://docs.openclaw.ai/tools)** — navigateur, canvas, nodes, cron, sessions et actions Discord/Slack.
- **[Applications compagnon](https://docs.openclaw.ai/platforms/macos)** — app barre de menu macOS + [nodes](https://docs.openclaw.ai/nodes) iOS/Android.
- **[Configuration initiale](https://docs.openclaw.ai/start/wizard) + [compétences](https://docs.openclaw.ai/tools/skills)** — configuration guidée par assistant avec compétences intégrées/gérées/d'espace de travail.

## Historique des étoiles

[![Graphique d'historique des étoiles](https://api.star-history.com/svg?repos=openclaw/openclaw&type=date&legend=top-left)](https://www.star-history.com/#openclaw/openclaw&type=date&legend=top-left)

## Tout ce que nous avons construit jusqu'à présent

### Plateforme principale

- [Plan de contrôle Gateway WS](https://docs.openclaw.ai/gateway) avec sessions, présence, config, cron, webhooks, [Interface de contrôle](https://docs.openclaw.ai/web) et [Hôte Canvas](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui).
- [Interface CLI](https://docs.openclaw.ai/tools/agent-send) : gateway, agent, send, [assistant](https://docs.openclaw.ai/start/wizard) et [doctor](https://docs.openclaw.ai/gateway/doctor).
- [Runtime d'agent Pi](https://docs.openclaw.ai/concepts/agent) en mode RPC avec streaming d'outils et streaming par blocs.
- [Modèle de session](https://docs.openclaw.ai/concepts/session) : `main` pour les discussions directes, isolation de groupe, modes d'activation, modes de file d'attente, réponse retour. Règles de groupe : [Groupes](https://docs.openclaw.ai/concepts/groups).
- [Pipeline média](https://docs.openclaw.ai/nodes/images) : images/audio/vidéo, hooks de transcription, limites de taille, cycle de vie des fichiers temporaires. Détails audio : [Audio](https://docs.openclaw.ai/nodes/audio).

### Canaux

- [Canaux](https://docs.openclaw.ai/channels) : [WhatsApp](https://docs.openclaw.ai/channels/whatsapp) (Baileys), [Telegram](https://docs.openclaw.ai/channels/telegram) (grammY), [Slack](https://docs.openclaw.ai/channels/slack) (Bolt), [Discord](https://docs.openclaw.ai/channels/discord) (discord.js), [Google Chat](https://docs.openclaw.ai/channels/googlechat) (Chat API), [Signal](https://docs.openclaw.ai/channels/signal) (signal-cli), [BlueBubbles](https://docs.openclaw.ai/channels/bluebubbles) (iMessage, recommandé), [iMessage](https://docs.openclaw.ai/channels/imessage) (ancien imsg), [Microsoft Teams](https://docs.openclaw.ai/channels/msteams) (extension), [Matrix](https://docs.openclaw.ai/channels/matrix) (extension), [Zalo](https://docs.openclaw.ai/channels/zalo) (extension), [Zalo Personal](https://docs.openclaw.ai/channels/zalouser) (extension), [WebChat](https://docs.openclaw.ai/web/webchat).
- [Routage de groupe](https://docs.openclaw.ai/concepts/group-messages) : contrôle des mentions, tags de réponse, découpage et routage par canal. Règles des canaux : [Canaux](https://docs.openclaw.ai/channels).

### Applications + nodes

- [App macOS](https://docs.openclaw.ai/platforms/macos) : plan de contrôle dans la barre de menu, [Voice Wake](https://docs.openclaw.ai/nodes/voicewake)/PTT, superposition [Mode Talk](https://docs.openclaw.ai/nodes/talk), [WebChat](https://docs.openclaw.ai/web/webchat), outils de débogage, contrôle de [passerelle distante](https://docs.openclaw.ai/gateway/remote).
- [Node iOS](https://docs.openclaw.ai/platforms/ios) : [Canvas](https://docs.openclaw.ai/platforms/mac/canvas), [Voice Wake](https://docs.openclaw.ai/nodes/voicewake), [Mode Talk](https://docs.openclaw.ai/nodes/talk), caméra, enregistrement d'écran, appairage Bonjour.
- [Node Android](https://docs.openclaw.ai/platforms/android) : [Canvas](https://docs.openclaw.ai/platforms/mac/canvas), [Mode Talk](https://docs.openclaw.ai/nodes/talk), caméra, enregistrement d'écran, SMS optionnel.
- [Mode node macOS](https://docs.openclaw.ai/nodes) : system.run/notify + exposition canvas/caméra.

### Outils + automatisation

- [Contrôle du navigateur](https://docs.openclaw.ai/tools/browser) : Chrome/Chromium dédié openclaw, captures, actions, uploads, profils.
- [Canvas](https://docs.openclaw.ai/platforms/mac/canvas) : [A2UI](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui) push/reset, eval, snapshot.
- [Nodes](https://docs.openclaw.ai/nodes) : snap/clip caméra, enregistrement d'écran, [location.get](https://docs.openclaw.ai/nodes/location-command), notifications.
- [Cron + réveils](https://docs.openclaw.ai/automation/cron-jobs) ; [webhooks](https://docs.openclaw.ai/automation/webhook) ; [Gmail Pub/Sub](https://docs.openclaw.ai/automation/gmail-pubsub).
- [Plateforme de compétences](https://docs.openclaw.ai/tools/skills) : compétences intégrées, gérées et d'espace de travail avec contrôle d'installation + UI.

### Runtime + sécurité

- [Routage des canaux](https://docs.openclaw.ai/concepts/channel-routing), [politique de nouvelle tentative](https://docs.openclaw.ai/concepts/retry) et [streaming/découpage](https://docs.openclaw.ai/concepts/streaming).
- [Présence](https://docs.openclaw.ai/concepts/presence), [indicateurs de frappe](https://docs.openclaw.ai/concepts/typing-indicators) et [suivi d'utilisation](https://docs.openclaw.ai/concepts/usage-tracking).
- [Modèles](https://docs.openclaw.ai/concepts/models), [basculement de modèle](https://docs.openclaw.ai/concepts/model-failover) et [élagage de session](https://docs.openclaw.ai/concepts/session-pruning).
- [Sécurité](https://docs.openclaw.ai/gateway/security) et [dépannage](https://docs.openclaw.ai/channels/troubleshooting).

### Ops + packaging

- [Interface de contrôle](https://docs.openclaw.ai/web) + [WebChat](https://docs.openclaw.ai/web/webchat) servis directement depuis la Passerelle.
- [Tailscale Serve/Funnel](https://docs.openclaw.ai/gateway/tailscale) ou [tunnels SSH](https://docs.openclaw.ai/gateway/remote) avec auth par jeton/mot de passe.
- [Mode Nix](https://docs.openclaw.ai/install/nix) pour config déclarative ; installations basées sur [Docker](https://docs.openclaw.ai/install/docker).
- Migrations [Doctor](https://docs.openclaw.ai/gateway/doctor), [journalisation](https://docs.openclaw.ai/logging).

## Fonctionnement (bref)

```
WhatsApp / Telegram / Slack / Discord / Google Chat / Signal / iMessage / BlueBubbles / Microsoft Teams / Matrix / Zalo / Zalo Personal / WebChat
               │
               ▼
┌───────────────────────────────┐
│           Passerelle          │
│       (plan de contrôle)      │
│     ws://127.0.0.1:18789      │
└──────────────┬────────────────┘
               │
               ├─ Agent Pi (RPC)
               ├─ CLI (openclaw …)
               ├─ Interface WebChat
               ├─ App macOS
               └─ Nodes iOS / Android
```

## Sous-systèmes clés

- **[Réseau WebSocket de la Passerelle](https://docs.openclaw.ai/concepts/architecture)** — plan de contrôle WS unique pour les clients, outils et événements (plus ops : [Manuel de la Passerelle](https://docs.openclaw.ai/gateway)).
- **[Exposition Tailscale](https://docs.openclaw.ai/gateway/tailscale)** — Serve/Funnel pour le tableau de bord de la Passerelle + WS (accès distant : [Distant](https://docs.openclaw.ai/gateway/remote)).
- **[Contrôle du navigateur](https://docs.openclaw.ai/tools/browser)** — Chrome/Chromium géré par openclaw avec contrôle CDP.
- **[Canvas + A2UI](https://docs.openclaw.ai/platforms/mac/canvas)** — espace de travail visuel piloté par l'agent (hôte A2UI : [Canvas/A2UI](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui)).
- **[Voice Wake](https://docs.openclaw.ai/nodes/voicewake) + [Mode Talk](https://docs.openclaw.ai/nodes/talk)** — reconnaissance vocale toujours active et conversation continue.
- **[Nodes](https://docs.openclaw.ai/nodes)** — Canvas, snap/clip caméra, enregistrement d'écran, `location.get`, notifications, plus `system.run`/`system.notify` exclusifs macOS.

## Accès Tailscale (tableau de bord de la Passerelle)

OpenClaw peut configurer automatiquement Tailscale **Serve** (tailnet uniquement) ou **Funnel** (public) pendant que la Passerelle reste liée au loopback. Configurez `gateway.tailscale.mode` :

- `off` : pas d'automatisation Tailscale (par défaut).
- `serve` : HTTPS tailnet uniquement via `tailscale serve` (utilise les en-têtes d'identité Tailscale par défaut).
- `funnel` : HTTPS public via `tailscale funnel` (nécessite une auth par mot de passe partagé).

Notes :

- `gateway.bind` doit rester `loopback` quand Serve/Funnel est activé (OpenClaw l'impose).
- Serve peut être forcé à exiger un mot de passe en définissant `gateway.auth.mode: "password"` ou `gateway.auth.allowTailscale: false`.
- Funnel refuse de démarrer sauf si `gateway.auth.mode: "password"` est défini.
- Optionnel : `gateway.tailscale.resetOnExit` pour annuler Serve/Funnel à l'arrêt.

Détails : [Guide Tailscale](https://docs.openclaw.ai/gateway/tailscale) · [Surfaces web](https://docs.openclaw.ai/web)

## Passerelle distante (Linux, c'est génial)

Il est parfaitement acceptable d'exécuter la Passerelle sur une petite instance Linux. Les clients (app macOS, CLI, WebChat) peuvent se connecter via **Tailscale Serve/Funnel** ou **tunnels SSH**, et vous pouvez toujours appairer des nodes d'appareil (macOS/iOS/Android) pour exécuter des actions locales à l'appareil si nécessaire.

- **L'hôte Passerelle** exécute l'outil exec et les connexions de canaux par défaut.
- **Les nodes d'appareil** exécutent des actions locales à l'appareil (`system.run`, caméra, enregistrement d'écran, notifications) via `node.invoke`.
  En bref : exec s'exécute là où vit la Passerelle ; les actions d'appareil s'exécutent là où vit l'appareil.

Détails : [Accès distant](https://docs.openclaw.ai/gateway/remote) · [Nodes](https://docs.openclaw.ai/nodes) · [Sécurité](https://docs.openclaw.ai/gateway/security)

## Permissions macOS via le protocole de la Passerelle

L'app macOS peut s'exécuter en **mode node** et annonce ses capacités + carte de permissions via le WebSocket de la Passerelle (`node.list` / `node.describe`). Les clients peuvent ensuite exécuter des actions locales via `node.invoke` :

- `system.run` exécute une commande locale et renvoie stdout/stderr/code de sortie ; définissez `needsScreenRecording: true` pour exiger la permission d'enregistrement d'écran (sinon vous obtiendrez `PERMISSION_MISSING`).
- `system.notify` publie une notification utilisateur et échoue si les notifications sont refusées.
- `canvas.*`, `camera.*`, `screen.record` et `location.get` sont également acheminés via `node.invoke` et suivent le statut de permission TCC.

Le bash élevé (permissions hôte) est séparé du TCC macOS :

- Utilisez `/elevated on|off` pour basculer l'accès élevé par session lorsqu'il est activé + sur liste blanche.
- La Passerelle persiste le basculement par session via `sessions.patch` (méthode WS) aux côtés de `thinkingLevel`, `verboseLevel`, `model`, `sendPolicy` et `groupActivation`.

Détails : [Nodes](https://docs.openclaw.ai/nodes) · [App macOS](https://docs.openclaw.ai/platforms/macos) · [Protocole de la Passerelle](https://docs.openclaw.ai/concepts/architecture)

## Agent vers Agent (outils sessions\_\*)

- Utilisez-les pour coordonner le travail entre sessions sans sauter entre les surfaces de discussion.
- `sessions_list` — découvrez les sessions (agents) actives et leurs métadonnées.
- `sessions_history` — récupérez les journaux de transcription pour une session.
- `sessions_send` — envoyez un message à une autre session ; ping-pong de réponse optionnel + étape d'annonce (`REPLY_SKIP`, `ANNOUNCE_SKIP`).

Détails : [Outils de session](https://docs.openclaw.ai/concepts/session-tool)

## Registre de compétences (ClawHub)

ClawHub est un registre de compétences minimal. Avec ClawHub activé, l'agent peut rechercher automatiquement des compétences et en intégrer de nouvelles selon les besoins.

[ClawHub](https://clawhub.com)

## Commandes de discussion

Envoyez-les dans WhatsApp/Telegram/Slack/Google Chat/Microsoft Teams/WebChat (les commandes de groupe sont réservées au propriétaire) :

- `/status` — statut de session compact (modèle + tokens, coût si disponible)
- `/new` ou `/reset` — réinitialiser la session
- `/compact` — compacter le contexte de session (résumé)
- `/think <niveau>` — off|minimal|low|medium|high|xhigh (modèles GPT-5.2 + Codex uniquement)
- `/verbose on|off`
- `/usage off|tokens|full` — pied de page d'utilisation par réponse
- `/restart` — redémarrer la passerelle (propriétaire uniquement dans les groupes)
- `/activation mention|always` — basculement d'activation de groupe (groupes uniquement)

## Applications (optionnelles)

La Passerelle seule offre une excellente expérience. Toutes les applications sont optionnelles et ajoutent des fonctionnalités supplémentaires.

Si vous prévoyez de construire/exécuter des applications compagnon, suivez les manuels de plateforme ci-dessous.

### macOS (OpenClaw.app) (optionnel)

- Contrôle de barre de menu pour la Passerelle et la santé.
- Voice Wake + superposition push-to-talk.
- WebChat + outils de débogage.
- Contrôle de passerelle distante via SSH.

Note : builds signés requis pour que les permissions macOS persistent entre les reconstructions (voir `docs/mac/permissions.md`).

### Node iOS (optionnel)

- S'appaire comme node via le Bridge.
- Transfert de déclenchement vocal + surface Canvas.
- Contrôlé via `openclaw nodes …`.

Manuel : [Connexion iOS](https://docs.openclaw.ai/platforms/ios).

### Node Android (optionnel)

- S'appaire via le même Bridge + flux d'appairage qu'iOS.
- Expose les commandes Canvas, Caméra et Capture d'écran.
- Manuel : [Connexion Android](https://docs.openclaw.ai/platforms/android).

## Espace de travail de l'agent + compétences

- Racine de l'espace de travail : `~/.openclaw/workspace` (configurable via `agents.defaults.workspace`).
- Fichiers de prompt injectés : `AGENTS.md`, `SOUL.md`, `TOOLS.md`.
- Compétences : `~/.openclaw/workspace/skills/<compétence>/SKILL.md`.

## Configuration

`~/.openclaw/openclaw.json` minimal (modèle + valeurs par défaut) :

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-6",
  },
}
```

[Référence de configuration complète (toutes les clés + exemples).](https://docs.openclaw.ai/gateway/configuration)

## Modèle de sécurité (important)

- **Par défaut :** les outils s'exécutent sur l'hôte pour la session **main**, donc l'agent a un accès complet quand c'est juste vous.
- **Sécurité groupe/canal :** définissez `agents.defaults.sandbox.mode: "non-main"` pour exécuter les **sessions non‑main** (groupes/canaux) dans des bacs à sable Docker par session ; bash s'exécute alors dans Docker pour ces sessions.
- **Valeurs par défaut du bac à sable :** liste blanche `bash`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn` ; liste noire `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`.

Détails : [Guide de sécurité](https://docs.openclaw.ai/gateway/security) · [Docker + sandboxing](https://docs.openclaw.ai/install/docker) · [Configuration du bac à sable](https://docs.openclaw.ai/gateway/configuration)

### [WhatsApp](https://docs.openclaw.ai/channels/whatsapp)

- Liez l'appareil : `pnpm openclaw channels login` (stocke les identifiants dans `~/.openclaw/credentials`).
- Liste blanche de qui peut parler à l'assistant via `channels.whatsapp.allowFrom`.
- Si `channels.whatsapp.groups` est défini, il devient une liste blanche de groupe ; incluez `"*"` pour autoriser tous.

### [Telegram](https://docs.openclaw.ai/channels/telegram)

- Définissez `TELEGRAM_BOT_TOKEN` ou `channels.telegram.botToken` (env gagne).
- Optionnel : définissez `channels.telegram.groups` (avec `channels.telegram.groups."*".requireMention`) ; lorsque défini, c'est une liste blanche de groupe (incluez `"*"` pour autoriser tous). Aussi `channels.telegram.allowFrom` ou `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` selon les besoins.

```json5
{
  channels: {
    telegram: {
      botToken: "123456:ABCDEF",
    },
  },
}
```

### [Slack](https://docs.openclaw.ai/channels/slack)

- Définissez `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` (ou `channels.slack.botToken` + `channels.slack.appToken`).

### [Discord](https://docs.openclaw.ai/channels/discord)

- Définissez `DISCORD_BOT_TOKEN` ou `channels.discord.token` (env gagne).
- Optionnel : définissez `commands.native`, `commands.text` ou `commands.useAccessGroups`, plus `channels.discord.allowFrom`, `channels.discord.guilds` ou `channels.discord.mediaMaxMb` selon les besoins.

```json5
{
  channels: {
    discord: {
      token: "1234abcd",
    },
  },
}
```

### [Signal](https://docs.openclaw.ai/channels/signal)

- Nécessite `signal-cli` et une section de config `channels.signal`.

### [BlueBubbles (iMessage)](https://docs.openclaw.ai/channels/bluebubbles)

- Intégration iMessage **recommandée**.
- Configurez `channels.bluebubbles.serverUrl` + `channels.bluebubbles.password` et un webhook (`channels.bluebubbles.webhookPath`).
- Le serveur BlueBubbles tourne sur macOS ; la Passerelle peut tourner sur macOS ou ailleurs.

### [iMessage (ancien)](https://docs.openclaw.ai/channels/imessage)

- Intégration macOS uniquement ancienne via `imsg` (Messages doit être connecté).
- Si `channels.imessage.groups` est défini, il devient une liste blanche de groupe ; incluez `"*"` pour autoriser tous.

### [Microsoft Teams](https://docs.openclaw.ai/channels/msteams)

- Configurez une app Teams + Bot Framework, puis ajoutez une section de config `msteams`.
- Liste blanche de qui peut parler via `msteams.allowFrom` ; accès groupe via `msteams.groupAllowFrom` ou `msteams.groupPolicy: "open"`.

### [WebChat](https://docs.openclaw.ai/web/webchat)

- Utilise le WebSocket de la Passerelle ; pas de port/config WebChat séparé.

Contrôle du navigateur (optionnel) :

```json5
{
  browser: {
    enabled: true,
    color: "#FF4500",
  },
}
```

## Documentation

Utilisez-les lorsque vous avez passé le flux de configuration initiale et voulez la référence plus approfondie.

- [Commencez par l'index de la documentation pour la navigation et "où est quoi".](https://docs.openclaw.ai)
- [Lisez l'aperçu de l'architecture pour le modèle de passerelle + protocole.](https://docs.openclaw.ai/concepts/architecture)
- [Utilisez la référence de configuration complète quand vous avez besoin de chaque clé et exemple.](https://docs.openclaw.ai/gateway/configuration)
- [Exploitez la Passerelle selon les règles avec le manuel opérationnel.](https://docs.openclaw.ai/gateway)
- [Découvrez comment fonctionnent l'Interface de contrôle/surfaces Web et comment les exposer en toute sécurité.](https://docs.openclaw.ai/web)
- [Comprenez l'accès distant via tunnels SSH ou tailnets.](https://docs.openclaw.ai/gateway/remote)
- [Suivez le flux de l'assistant de configuration initiale pour une installation guidée.](https://docs.openclaw.ai/start/wizard)
- [Connectez des déclencheurs externes via la surface webhook.](https://docs.openclaw.ai/automation/webhook)
- [Configurez les déclencheurs Gmail Pub/Sub.](https://docs.openclaw.ai/automation/gmail-pubsub)
- [Découvrez les détails de l'app compagnon barre de menu macOS.](https://docs.openclaw.ai/platforms/mac/menu-bar)
- [Guides de plateforme : Windows (WSL2)](https://docs.openclaw.ai/platforms/windows), [Linux](https://docs.openclaw.ai/platforms/linux), [macOS](https://docs.openclaw.ai/platforms/macos), [iOS](https://docs.openclaw.ai/platforms/ios), [Android](https://docs.openclaw.ai/platforms/android)
- [Déboguez les échecs courants avec le guide de dépannage.](https://docs.openclaw.ai/channels/troubleshooting)
- [Examinez les conseils de sécurité avant d'exposer quoi que ce soit.](https://docs.openclaw.ai/gateway/security)

## Documentation avancée (découverte + contrôle)

- [Découverte + transports](https://docs.openclaw.ai/gateway/discovery)
- [Bonjour/mDNS](https://docs.openclaw.ai/gateway/bonjour)
- [Appairage de passerelle](https://docs.openclaw.ai/gateway/pairing)
- [README de passerelle distante](https://docs.openclaw.ai/gateway/remote-gateway-readme)
- [Interface de contrôle](https://docs.openclaw.ai/web/control-ui)
- [Tableau de bord](https://docs.openclaw.ai/web/dashboard)

## Opérations & dépannage

- [Vérifications de santé](https://docs.openclaw.ai/gateway/health)
- [Verrou de passerelle](https://docs.openclaw.ai/gateway/gateway-lock)
- [Processus en arrière-plan](https://docs.openclaw.ai/gateway/background-process)
- [Dépannage du navigateur (Linux)](https://docs.openclaw.ai/tools/browser-linux-troubleshooting)
- [Journalisation](https://docs.openclaw.ai/logging)

## Plongées approfondies

- [Boucle de l'agent](https://docs.openclaw.ai/concepts/agent-loop)
- [Présence](https://docs.openclaw.ai/concepts/presence)
- [Schémas TypeBox](https://docs.openclaw.ai/concepts/typebox)
- [Adaptateurs RPC](https://docs.openclaw.ai/reference/rpc)
- [File d'attente](https://docs.openclaw.ai/concepts/queue)

## Espace de travail & compétences

- [Configuration des compétences](https://docs.openclaw.ai/tools/skills-config)
- [AGENTS par défaut](https://docs.openclaw.ai/reference/AGENTS.default)
- [Modèles : AGENTS](https://docs.openclaw.ai/reference/templates/AGENTS)
- [Modèles : BOOTSTRAP](https://docs.openclaw.ai/reference/templates/BOOTSTRAP)
- [Modèles : IDENTITY](https://docs.openclaw.ai/reference/templates/IDENTITY)
- [Modèles : SOUL](https://docs.openclaw.ai/reference/templates/SOUL)
- [Modèles : TOOLS](https://docs.openclaw.ai/reference/templates/TOOLS)
- [Modèles : USER](https://docs.openclaw.ai/reference/templates/USER)

## Internes de plateforme

- [Configuration de développement macOS](https://docs.openclaw.ai/platforms/mac/dev-setup)
- [Barre de menu macOS](https://docs.openclaw.ai/platforms/mac/menu-bar)
- [Voice wake macOS](https://docs.openclaw.ai/platforms/mac/voicewake)
- [Node iOS](https://docs.openclaw.ai/platforms/ios)
- [Node Android](https://docs.openclaw.ai/platforms/android)
- [Windows (WSL2)](https://docs.openclaw.ai/platforms/windows)
- [App Linux](https://docs.openclaw.ai/platforms/linux)

## Hooks email (Gmail)

- [docs.openclaw.ai/gmail-pubsub](https://docs.openclaw.ai/automation/gmail-pubsub)

## Molty

OpenClaw a été construit pour **Molty**, un assistant IA homard spatial. 🦞
par Peter Steinberger et la communauté.

- [openclaw.ai](https://openclaw.ai)
- [soul.md](https://soul.md)
- [steipete.me](https://steipete.me)
- [@openclaw](https://x.com/openclaw)

## Communauté

Voir [CONTRIBUTING.md](CONTRIBUTING.md) pour les directives, les mainteneurs et comment soumettre des PR.
Les PR assistées par IA/vibe-coded sont les bienvenues ! 🤖

Remerciements spéciaux à [Mario Zechner](https://mariozechner.at/) pour son soutien et pour
[pi-mono](https://github.com/badlogic/pi-mono).
Remerciements spéciaux à Adam Doppelt pour lobster.bot.

Merci à tous les clawtributeurs :

<p align="left">
  <a href="https://github.com/steipete"><img src="https://avatars.githubusercontent.com/u/58493?v=4&s=48" width="48" height="48" alt="steipete" title="steipete"/></a> <a href="https://github.com/joshp123"><img src="https://avatars.githubusercontent.com/u/1497361?v=4&s=48" width="48" height="48" alt="joshp123" title="joshp123"/></a> <a href="https://github.com/cpojer"><img src="https://avatars.githubusercontent.com/u/13352?v=4&s=48" width="48" height="48" alt="cpojer" title="cpojer"/></a> <a href="https://github.com/mbelinky"><img src="https://avatars.githubusercontent.com/u/132747814?v=4&s=48" width="48" height="48" alt="Mariano Belinky" title="Mariano Belinky"/></a> <a href="https://github.com/sebslight"><img src="https://avatars.githubusercontent.com/u/19554889?v=4&s=48" width="48" height="48" alt="sebslight" title="sebslight"/></a> <a href="https://github.com/Takhoffman"><img src="https://avatars.githubusercontent.com/u/781889?v=4&s=48" width="48" height="48" alt="Takhoffman" title="Takhoffman"/></a> <a href="https://github.com/quotentiroler"><img src="https://avatars.githubusercontent.com/u/40643627?v=4&s=48" width="48" height="48" alt="quotentiroler" title="quotentiroler"/></a> <a href="https://github.com/bohdanpodvirnyi"><img src="https://avatars.githubusercontent.com/u/31819391?v=4&s=48" width="48" height="48" alt="bohdanpodvirnyi" title="bohdanpodvirnyi"/></a> <a href="https://github.com/tyler6204"><img src="https://avatars.githubusercontent.com/u/64381258?v=4&s=48" width="48" height="48" alt="tyler6204" title="tyler6204"/></a> <a href="https://github.com/iHildy"><img src="https://avatars.githubusercontent.com/u/25069719?v=4&s=48" width="48" height="48" alt="iHildy" title="iHildy"/></a>
  <a href="https://github.com/jaydenfyi"><img src="https://avatars.githubusercontent.com/u/213395523?v=4&s=48" width="48" height="48" alt="jaydenfyi" title="jaydenfyi"/></a> <a href="https://github.com/gumadeiras"><img src="https://avatars.githubusercontent.com/u/5599352?v=4&s=48" width="48" height="48" alt="gumadeiras" title="gumadeiras"/></a> <a href="https://github.com/joaohlisboa"><img src="https://avatars.githubusercontent.com/u/8200873?v=4&s=48" width="48" height="48" alt="joaohlisboa" title="joaohlisboa"/></a> <a href="https://github.com/mneves75"><img src="https://avatars.githubusercontent.com/u/2423436?v=4&s=48" width="48" height="48" alt="mneves75" title="mneves75"/></a> <a href="https://github.com/MatthieuBizien"><img src="https://avatars.githubusercontent.com/u/173090?v=4&s=48" width="48" height="48" alt="MatthieuBizien" title="MatthieuBizien"/></a> <a href="https://github.com/Glucksberg"><img src="https://avatars.githubusercontent.com/u/80581902?v=4&s=48" width="48" height="48" alt="Glucksberg" title="Glucksberg"/></a> <a href="https://github.com/MaudeBot"><img src="https://avatars.githubusercontent.com/u/255777700?v=4&s=48" width="48" height="48" alt="MaudeBot" title="MaudeBot"/></a> <a href="https://github.com/rahthakor"><img src="https://avatars.githubusercontent.com/u/8470553?v=4&s=48" width="48" height="48" alt="rahthakor" title="rahthakor"/></a> <a href="https://github.com/vrknetha"><img src="https://avatars.githubusercontent.com/u/20596261?v=4&s=48" width="48" height="48" alt="vrknetha" title="vrknetha"/></a> <a href="https://github.com/vignesh07"><img src="https://avatars.githubusercontent.com/u/1436853?v=4&s=48" width="48" height="48" alt="vignesh07" title="vignesh07"/></a>
  <a href="https://github.com/radek-paclt"><img src="https://avatars.githubusercontent.com/u/50451445?v=4&s=48" width="48" height="48" alt="radek-paclt" title="radek-paclt"/></a> <a href="https://github.com/abdelsfane"><img src="https://avatars.githubusercontent.com/u/32418586?v=4&s=48" width="48" height="48" alt="abdelsfane" title="abdelsfane"/></a> <a href="https://github.com/tobiasbischoff"><img src="https://avatars.githubusercontent.com/u/711564?v=4&s=48" width="48" height="48" alt="Tobias Bischoff" title="Tobias Bischoff"/></a> <a href="https://github.com/christianklotz"><img src="https://avatars.githubusercontent.com/u/69443?v=4&s=48" width="48" height="48" alt="christianklotz" title="christianklotz"/></a> <a href="https://github.com/czekaj"><img src="https://avatars.githubusercontent.com/u/1464539?v=4&s=48" width="48" height="48" alt="czekaj" title="czekaj"/></a> <a href="https://github.com/ethanpalm"><img src="https://avatars.githubusercontent.com/u/56270045?v=4&s=48" width="48" height="48" alt="ethanpalm" title="ethanpalm"/></a> <a href="https://github.com/mukhtharcm"><img src="https://avatars.githubusercontent.com/u/56378562?v=4&s=48" width="48" height="48" alt="mukhtharcm" title="mukhtharcm"/></a> <a href="https://github.com/maxsumrall"><img src="https://avatars.githubusercontent.com/u/628843?v=4&s=48" width="48" height="48" alt="maxsumrall" title="maxsumrall"/></a> <a href="https://github.com/rodrigouroz"><img src="https://avatars.githubusercontent.com/u/384037?v=4&s=48" width="48" height="48" alt="rodrigouroz" title="rodrigouroz"/></a> <a href="https://github.com/xadenryan"><img src="https://avatars.githubusercontent.com/u/165437834?v=4&s=48" width="48" height="48" alt="xadenryan" title="xadenryan"/></a>
  <a href="https://github.com/VACInc"><img src="https://avatars.githubusercontent.com/u/3279061?v=4&s=48" width="48" height="48" alt="VACInc" title="VACInc"/></a> <a href="https://github.com/juanpablodlc"><img src="https://avatars.githubusercontent.com/u/92012363?v=4&s=48" width="48" height="48" alt="juanpablodlc" title="juanpablodlc"/></a> <a href="https://github.com/conroywhitney"><img src="https://avatars.githubusercontent.com/u/249891?v=4&s=48" width="48" height="48" alt="conroywhitney" title="conroywhitney"/></a> <a href="https://github.com/hsrvc"><img src="https://avatars.githubusercontent.com/u/129702169?v=4&s=48" width="48" height="48" alt="hsrvc" title="hsrvc"/></a> <a href="https://github.com/magimetal"><img src="https://avatars.githubusercontent.com/u/36491250?v=4&s=48" width="48" height="48" alt="magimetal" title="magimetal"/></a> <a href="https://github.com/zerone0x"><img src="https://avatars.githubusercontent.com/u/39543393?v=4&s=48" width="48" height="48" alt="zerone0x" title="zerone0x"/></a> <a href="https://github.com/advaitpaliwal"><img src="https://avatars.githubusercontent.com/u/66044327?v=4&s=48" width="48" height="48" alt="advaitpaliwal" title="advaitpaliwal"/></a> <a href="https://github.com/meaningfool"><img src="https://avatars.githubusercontent.com/u/2862331?v=4&s=48" width="48" height="48" alt="meaningfool" title="meaningfool"/></a> <a href="https://github.com/patelhiren"><img src="https://avatars.githubusercontent.com/u/172098?v=4&s=48" width="48" height="48" alt="patelhiren" title="patelhiren"/></a> <a href="https://github.com/NicholasSpisak"><img src="https://avatars.githubusercontent.com/u/129075147?v=4&s=48" width="48" height="48" alt="NicholasSpisak" title="NicholasSpisak"/></a>
  <a href="https://github.com/jonisjongithub"><img src="https://avatars.githubusercontent.com/u/86072337?v=4&s=48" width="48" height="48" alt="jonisjongithub" title="jonisjongithub"/></a> <a href="https://github.com/AbhisekBasu1"><img src="https://avatars.githubusercontent.com/u/40645221?v=4&s=48" width="48" height="48" alt="abhisekbasu1" title="abhisekbasu1"/></a> <a href="https://github.com/theonejvo"><img src="https://avatars.githubusercontent.com/u/125909656?v=4&s=48" width="48" height="48" alt="theonejvo" title="theonejvo"/></a> <a href="https://github.com/jamesgroat"><img src="https://avatars.githubusercontent.com/u/2634024?v=4&s=48" width="48" height="48" alt="jamesgroat" title="jamesgroat"/></a> <a href="https://github.com/BunsDev"><img src="https://avatars.githubusercontent.com/u/68980965?v=4&s=48" width="48" height="48" alt="BunsDev" title="BunsDev"/></a> <a href="https://github.com/claude"><img src="https://avatars.githubusercontent.com/u/81847?v=4&s=48" width="48" height="48" alt="claude" title="claude"/></a> <a href="https://github.com/JustYannicc"><img src="https://avatars.githubusercontent.com/u/52761674?v=4&s=48" width="48" height="48" alt="JustYannicc" title="JustYannicc"/></a> <a href="https://github.com/Hyaxia"><img src="https://avatars.githubusercontent.com/u/36747317?v=4&s=48" width="48" height="48" alt="Hyaxia" title="Hyaxia"/></a> <a href="https://github.com/dantelex"><img src="https://avatars.githubusercontent.com/u/631543?v=4&s=48" width="48" height="48" alt="dantelex" title="dantelex"/></a> <a href="https://github.com/SocialNerd42069"><img src="https://avatars.githubusercontent.com/u/118244303?v=4&s=48" width="48" height="48" alt="SocialNerd42069" title="SocialNerd42069"/></a>
  <a href="https://github.com/daveonkels"><img src="https://avatars.githubusercontent.com/u/533642?v=4&s=48" width="48" height="48" alt="daveonkels" title="daveonkels"/></a> <a href="https://github.com/Yida-Dev"><img src="https://avatars.githubusercontent.com/u/92713555?v=4&s=48" width="48" height="48" alt="Yida-Dev" title="Yida-Dev"/></a> <a href="https://github.com/apps/google-labs-jules"><img src="https://avatars.githubusercontent.com/in/842251?v=4&s=48" width="48" height="48" alt="google-labs-jules[bot]" title="google-labs-jules[bot]"/></a> <a href="https://github.com/riccardogiorato"><img src="https://avatars.githubusercontent.com/u/4527364?v=4&s=48" width="48" height="48" alt="riccardogiorato" title="riccardogiorato"/></a> <a href="https://github.com/lc0rp"><img src="https://avatars.githubusercontent.com/u/2609441?v=4&s=48" width="48" height="48" alt="lc0rp" title="lc0rp"/></a> <a href="https://github.com/adam91holt"><img src="https://avatars.githubusercontent.com/u/9592417?v=4&s=48" width="48" height="48" alt="adam91holt" title="adam91holt"/></a> <a href="https://github.com/mousberg"><img src="https://avatars.githubusercontent.com/u/57605064?v=4&s=48" width="48" height="48" alt="mousberg" title="mousberg"/></a> <a href="https://github.com/apps/clawdinator"><img src="https://avatars.githubusercontent.com/in/2607181?v=4&s=48" width="48" height="48" alt="clawdinator[bot]" title="clawdinator[bot]"/></a> <a href="https://github.com/hougangdev"><img src="https://avatars.githubusercontent.com/u/105773686?v=4&s=48" width="48" height="48" alt="hougangdev" title="hougangdev"/></a> <a href="https://github.com/shakkernerd"><img src="https://avatars.githubusercontent.com/u/165377636?v=4&s=48" width="48" height="48" alt="shakkernerd" title="shakkernerd"/></a>
  <a href="https://github.com/coygeek"><img src="https://avatars.githubusercontent.com/u/65363919?v=4&s=48" width="48" height="48" alt="coygeek" title="coygeek"/></a> <a href="https://github.com/mteam88"><img src="https://avatars.githubusercontent.com/u/84196639?v=4&s=48" width="48" height="48" alt="mteam88" title="mteam88"/></a> <a href="https://github.com/hirefrank"><img src="https://avatars.githubusercontent.com/u/183158?v=4&s=48" width="48" height="48" alt="hirefrank" title="hirefrank"/></a> <a href="https://github.com/M00N7682"><img src="https://avatars.githubusercontent.com/u/170746674?v=4&s=48" width="48" height="48" alt="M00N7682" title="M00N7682"/></a> <a href="https://github.com/joeynyc"><img src="https://avatars.githubusercontent.com/u/17919866?v=4&s=48" width="48" height="48" alt="joeynyc" title="joeynyc"/></a> <a href="https://github.com/orlyjamie"><img src="https://avatars.githubusercontent.com/u/6668807?v=4&s=48" width="48" height="48" alt="orlyjamie" title="orlyjamie"/></a> <a href="https://github.com/dbhurley"><img src="https://avatars.githubusercontent.com/u/5251425?v=4&s=48" width="48" height="48" alt="dbhurley" title="dbhurley"/></a> <a href="https://github.com/omniwired"><img src="https://avatars.githubusercontent.com/u/322761?v=4&s=48" width="48" height="48" alt="Eng. Juan Combetto" title="Eng. Juan Combetto"/></a> <a href="https://github.com/TSavo"><img src="https://avatars.githubusercontent.com/u/877990?v=4&s=48" width="48" height="48" alt="TSavo" title="TSavo"/></a> <a href="https://github.com/aerolalit"><img src="https://avatars.githubusercontent.com/u/17166039?v=4&s=48" width="48" height="48" alt="aerolalit" title="aerolalit"/></a>
  <a href="https://github.com/julianengel"><img src="https://avatars.githubusercontent.com/u/10634231?v=4&s=48" width="48" height="48" alt="julianengel" title="julianengel"/></a> <a href="https://github.com/bradleypriest"><img src="https://avatars.githubusercontent.com/u/167215?v=4&s=48" width="48" height="48" alt="bradleypriest" title="bradleypriest"/></a> <a href="https://github.com/benithors"><img src="https://avatars.githubusercontent.com/u/20652882?v=4&s=48" width="48" height="48" alt="benithors" title="benithors"/></a> <a href="https://github.com/lsh411"><img src="https://avatars.githubusercontent.com/u/6801488?v=4&s=48" width="48" height="48" alt="lsh411" title="lsh411"/></a> <a href="https://github.com/gut-puncture"><img src="https://avatars.githubusercontent.com/u/75851986?v=4&s=48" width="48" height="48" alt="gut-puncture" title="gut-puncture"/></a> <a href="https://github.com/rohannagpal"><img src="https://avatars.githubusercontent.com/u/4009239?v=4&s=48" width="48" height="48" alt="rohannagpal" title="rohannagpal"/></a> <a href="https://github.com/timolins"><img src="https://avatars.githubusercontent.com/u/1440854?v=4&s=48" width="48" height="48" alt="timolins" title="timolins"/></a> <a href="https://github.com/f-trycua"><img src="https://avatars.githubusercontent.com/u/195596869?v=4&s=48" width="48" height="48" alt="f-trycua" title="f-trycua"/></a> <a href="https://github.com/benostein"><img src="https://avatars.githubusercontent.com/u/31802821?v=4&s=48" width="48" height="48" alt="benostein" title="benostein"/></a> <a href="https://github.com/elliotsecops"><img src="https://avatars.githubusercontent.com/u/141947839?v=4&s=48" width="48" height="48" alt="elliotsecops" title="elliotsecops"/></a>
  <a href="https://github.com/Nachx639"><img src="https://avatars.githubusercontent.com/u/71144023?v=4&s=48" width="48" height="48" alt="nachx639" title="nachx639"/></a> <a href="https://github.com/pvoo"><img src="https://avatars.githubusercontent.com/u/20116814?v=4&s=48" width="48" height="48" alt="pvoo" title="pvoo"/></a> <a href="https://github.com/sreekaransrinath"><img src="https://avatars.githubusercontent.com/u/50989977?v=4&s=48" width="48" height="48" alt="sreekaransrinath" title="sreekaransrinath"/></a> <a href="https://github.com/gupsammy"><img src="https://avatars.githubusercontent.com/u/20296019?v=4&s=48" width="48" height="48" alt="gupsammy" title="gupsammy"/></a> <a href="https://github.com/cristip73"><img src="https://avatars.githubusercontent.com/u/24499421?v=4&s=48" width="48" height="48" alt="cristip73" title="cristip73"/></a> <a href="https://github.com/stefangalescu"><img src="https://avatars.githubusercontent.com/u/52995748?v=4&s=48" width="48" height="48" alt="stefangalescu" title="stefangalescu"/></a> <a href="https://github.com/nachoiacovino"><img src="https://avatars.githubusercontent.com/u/50103937?v=4&s=48" width="48" height="48" alt="nachoiacovino" title="nachoiacovino"/></a> <a href="https://github.com/vsabavat"><img src="https://avatars.githubusercontent.com/u/50385532?v=4&s=48" width="48" height="48" alt="Vasanth Rao Naik Sabavat" title="Vasanth Rao Naik Sabavat"/></a> <a href="https://github.com/thewilloftheshadow"><img src="https://avatars.githubusercontent.com/u/35580099?v=4&s=48" width="48" height="48" alt="thewilloftheshadow" title="thewilloftheshadow"/></a> <a href="https://github.com/petter-b"><img src="https://avatars.githubusercontent.com/u/62076402?v=4&s=48" width="48" height="48" alt="petter-b" title="petter-b"/></a>
  <a href="https://github.com/leszekszpunar"><img src="https://avatars.githubusercontent.com/u/13106764?v=4&s=48" width="48" height="48" alt="leszekszpunar" title="leszekszpunar"/></a> <a href="https://github.com/scald"><img src="https://avatars.githubusercontent.com/u/1215913?v=4&s=48" width="48" height="48" alt="scald" title="scald"/></a> <a href="https://github.com/pycckuu"><img src="https://avatars.githubusercontent.com/u/1489583?v=4&s=48" width="48" height="48" alt="pycckuu" title="pycckuu"/></a> <a href="https://github.com/AnonO6"><img src="https://avatars.githubusercontent.com/u/124311066?v=4&s=48" width="48" height="48" alt="AnonO6" title="AnonO6"/></a> <a href="https://github.com/andranik-sahakyan"><img src="https://avatars.githubusercontent.com/u/8908029?v=4&s=48" width="48" height="48" alt="andranik-sahakyan" title="andranik-sahakyan"/></a> <a href="https://github.com/davidguttman"><img src="https://avatars.githubusercontent.com/u/431696?v=4&s=48" width="48" height="48" alt="davidguttman" title="davidguttman"/></a> <a href="https://github.com/jarvis89757"><img src="https://avatars.githubusercontent.com/u/258175441?v=4&s=48" width="48" height="48" alt="jarvis89757" title="jarvis89757"/></a> <a href="https://github.com/sleontenko"><img src="https://avatars.githubusercontent.com/u/7135949?v=4&s=48" width="48" height="48" alt="sleontenko" title="sleontenko"/></a> <a href="https://github.com/denysvitali"><img src="https://avatars.githubusercontent.com/u/4939519?v=4&s=48" width="48" height="48" alt="denysvitali" title="denysvitali"/></a> <a href="https://github.com/TinyTb"><img src="https://avatars.githubusercontent.com/u/5957298?v=4&s=48" width="48" height="48" alt="TinyTb" title="TinyTb"/></a>
  <a href="https://github.com/sircrumpet"><img src="https://avatars.githubusercontent.com/u/4436535?v=4&s=48" width="48" height="48" alt="sircrumpet" title="sircrumpet"/></a> <a href="https://github.com/peschee"><img src="https://avatars.githubusercontent.com/u/63866?v=4&s=48" width="48" height="48" alt="peschee" title="peschee"/></a> <a href="https://github.com/nicolasstanley"><img src="https://avatars.githubusercontent.com/u/60584925?v=4&s=48" width="48" height="48" alt="nicolasstanley" title="nicolasstanley"/></a> <a href="https://github.com/davidiach"><img src="https://avatars.githubusercontent.com/u/28102235?v=4&s=48" width="48" height="48" alt="davidiach" title="davidiach"/></a> <a href="https://github.com/nonggialiang"><img src="https://avatars.githubusercontent.com/u/14367839?v=4&s=48" width="48" height="48" alt="nonggia.liang" title="nonggia.liang"/></a> <a href="https://github.com/ironbyte-rgb"><img src="https://avatars.githubusercontent.com/u/230665944?v=4&s=48" width="48" height="48" alt="ironbyte-rgb" title="ironbyte-rgb"/></a> <a href="https://github.com/dominicnunez"><img src="https://avatars.githubusercontent.com/u/43616264?v=4&s=48" width="48" height="48" alt="dominicnunez" title="dominicnunez"/></a> <a href="https://github.com/lploc94"><img src="https://avatars.githubusercontent.com/u/28453843?v=4&s=48" width="48" height="48" alt="lploc94" title="lploc94"/></a> <a href="https://github.com/ratulsarna"><img src="https://avatars.githubusercontent.com/u/105903728?v=4&s=48" width="48" height="48" alt="ratulsarna" title="ratulsarna"/></a> <a href="https://github.com/sfo2001"><img src="https://avatars.githubusercontent.com/u/103369858?v=4&s=48" width="48" height="48" alt="sfo2001" title="sfo2001"/></a>
  <a href="https://github.com/duhayildirim"><img src="https://avatars.githubusercontent.com/u/35707472?v=4&s=48" width="48" height="48" alt="duhayildirim" title="duhayildirim"/></a> <a href="https://github.com/mwz"><img src="https://avatars.githubusercontent.com/u/1190768?v=4&s=48" width="48" height="48" alt="mwz" title="mwz"/></a> <a href="https://github.com/markjfisher"><img src="https://avatars.githubusercontent.com/u/4152?v=4&s=48" width="48" height="48" alt="markjfisher" title="markjfisher"/></a> <a href="https://github.com/niraj1998ranjan"><img src="https://avatars.githubusercontent.com/u/37723899?v=4&s=48" width="48" height="48" alt="niraj1998ranjan" title="niraj1998ranjan"/></a>
</p>
