# 🦞 OpenClaw — Assistant IA Personnel

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.png">
        <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.png" alt="OpenClaw" width="500">
    </picture>
</p>

<p align="center">
  <strong>EXFOLIATE! EXFOLIATE!</strong>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="Statut CI"></a>
  <a href="https://github.com/openclaw/openclaw/releases"><img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="Version GitHub"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="Licence MIT"></a>
</p>

**OpenClaw** est un _assistant IA personnel_ que vous hébergez sur vos propres appareils.
Il vous répond sur les canaux que vous utilisez déjà (WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, Microsoft Teams, WebChat), ainsi que sur des canaux d'extension comme BlueBubbles, Matrix, Zalo et Zalo Personal. Il peut parler et écouter sur macOS/iOS/Android, et peut afficher un Canvas interactif que vous contrôlez. La Gateway est juste le plan de contrôle — le produit est l'assistant.

Si vous voulez un assistant personnel, mono-utilisateur, qui semble local, rapide et toujours disponible, c'est celui qu'il vous faut.

[Site Web](https://openclaw.ai) · [Docs](https://docs.openclaw.ai) · [DeepWiki](https://deepwiki.com/openclaw/openclaw) · [Premiers Pas](https://docs.openclaw.ai/start/getting-started) · [Mise à jour](https://docs.openclaw.ai/install/updating) · [Showcase](https://docs.openclaw.ai/start/showcase) · [FAQ](https://docs.openclaw.ai/start/faq) · [Assistant](https://docs.openclaw.ai/start/wizard) · [Nix](https://github.com/openclaw/nix-openclaw) · [Docker](https://docs.openclaw.ai/install/docker) · [Discord](https://discord.gg/clawd)

Configuration préférée : lancez l'assistant d'installation (`openclaw onboard`) dans votre terminal.
L'assistant vous guide étape par étape pour configurer la gateway, l'espace de travail, les canaux et les compétences. L'assistant CLI est la méthode recommandée et fonctionne sur **macOS, Linux et Windows (via WSL2 ; fortement recommandé)**.
Fonctionne avec npm, pnpm ou bun.
Nouvelle installation ? Commencez ici : [Premiers pas](https://docs.openclaw.ai/start/getting-started)

**Abonnements (OAuth) :**

- **[Anthropic](https://www.anthropic.com/)** (Claude Pro/Max)
- **[OpenAI](https://openai.com/)** (ChatGPT/Codex)

Note sur les modèles : bien que n'importe quel modèle soit supporté, je recommande fortement **Anthropic Pro/Max (100/200) + Opus 4.6** pour sa gestion du contexte long et une meilleure résistance à l'injection de prompt. Voir [Onboarding](https://docs.openclaw.ai/start/onboarding).

## Modèles (sélection + auth)

- Config modèles + CLI : [Modèles](https://docs.openclaw.ai/concepts/models)
- Rotation profil auth (OAuth vs clés API) + solutions de repli : [Basculement de modèle](https://docs.openclaw.ai/concepts/model-failover)

## Installation (recommandée)

Runtime : **Node ≥22**.

```bash
npm install -g openclaw@latest
# ou : pnpm add -g openclaw@latest

openclaw onboard --install-daemon
```

L'assistant installe le démon Gateway (service utilisateur launchd/systemd) pour qu'il reste actif.

## Démarrage rapide (TL;DR)

Runtime : **Node ≥22**.

Guide complet pour débutants (auth, appairage, canaux) : [Premiers pas](https://docs.openclaw.ai/start/getting-started)

```bash
openclaw onboard --install-daemon

openclaw gateway --port 18789 --verbose

# Envoyer un message
openclaw message send --to +1234567890 --message "Bonjour depuis OpenClaw"

# Parler à l'assistant (optionnellement répondre via n'importe quel canal connecté : WhatsApp/Telegram/Slack/Discord/Google Chat/Signal/iMessage/BlueBubbles/Microsoft Teams/Matrix/Zalo/Zalo Personal/WebChat)
openclaw agent --message "Checklist d'expédition" --thinking high
```

Mise à jour ? [Guide de mise à jour](https://docs.openclaw.ai/install/updating) (et lancez `openclaw doctor`).

## Canaux de développement

- **stable** : versions taguées (`vYYYY.M.D` ou `vYYYY.M.D-<patch>`), npm dist-tag `latest`.
- **beta** : tags de pré-version (`vYYYY.M.D-beta.N`), npm dist-tag `beta` (l'application macOS peut être manquante).
- **dev** : tête mobile de `main`, npm dist-tag `dev` (lorsque publié).

Changer de canal (git + npm) : `openclaw update --channel stable|beta|dev`.
Détails : [Canaux de développement](https://docs.openclaw.ai/install/development-channels).

## Depuis la source (développement)

Préférez `pnpm` pour les builds depuis la source. Bun est optionnel pour exécuter TypeScript directement.

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw

pnpm install
pnpm ui:build # installe auto les dépendances UI au premier lancement
pnpm build

pnpm openclaw onboard --install-daemon

# Boucle de dev (rechargement auto sur changements TS)
pnpm gateway:watch
```

Note : `pnpm openclaw ...` exécute TypeScript directement (via `tsx`). `pnpm build` produit `dist/` pour l'exécution via Node / le binaire `openclaw` empaqueté.

## Sécurité par défaut (Accès DM)

OpenClaw se connecte à de vraies surfaces de messagerie. Traitez les DM entrants comme des **entrées non fiables**.

Guide de sécurité complet : [Sécurité](https://docs.openclaw.ai/gateway/security)

Comportement par défaut sur Telegram/WhatsApp/Signal/iMessage/Microsoft Teams/Discord/Google Chat/Slack :

- **Appairage DM** (`dmPolicy="pairing"` / `channels.discord.dmPolicy="pairing"` / `channels.slack.dmPolicy="pairing"` ; ancien : `channels.discord.dm.policy`, `channels.slack.dm.policy`) : les expéditeurs inconnus reçoivent un court code d'appairage et le bot ne traite pas leur message.
- Approuver avec : `openclaw pairing approve <channel> <code>` (l'expéditeur est alors ajouté à une liste blanche locale).
- Les DM entrants publics nécessitent une inscription explicite : définissez `dmPolicy="open"` et incluez `"*"` dans la liste blanche du canal (`allowFrom` / `channels.discord.allowFrom` / `channels.slack.allowFrom` ; ancien : `channels.discord.dm.allowFrom`, `channels.slack.dm.allowFrom`).

Lancez `openclaw doctor` pour identifier les politiques DM risquées/mal configurées.

## Points forts

- **[Gateway locale](https://docs.openclaw.ai/gateway)** — plan de contrôle unique pour sessions, canaux, outils et événements.
- **[Boîte de réception multi-canaux](https://docs.openclaw.ai/channels)** — WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, BlueBubbles (iMessage), iMessage (ancien), Microsoft Teams, Matrix, Zalo, Zalo Personal, WebChat, macOS, iOS/Android.
- **[Routage multi-agents](https://docs.openclaw.ai/gateway/configuration)** — routez les canaux/comptes/pairs entrants vers des agents isolés (espaces de travail + sessions par agent).
- **[Réveil vocal](https://docs.openclaw.ai/nodes/voicewake) + [Mode conversation](https://docs.openclaw.ai/nodes/talk)** — parole toujours active pour macOS/iOS/Android avec ElevenLabs.
- **[Canvas en direct](https://docs.openclaw.ai/platforms/mac/canvas)** — espace de travail visuel piloté par l'agent avec [A2UI](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui).
- **[Outils de première classe](https://docs.openclaw.ai/tools)** — navigateur, canvas, nœuds, cron, sessions et actions Discord/Slack.
- **[Applications compagnons](https://docs.openclaw.ai/platforms/macos)** — app barre de menu macOS + [nœuds](https://docs.openclaw.ai/nodes) iOS/Android.
- **[Onboarding](https://docs.openclaw.ai/start/wizard) + [compétences](https://docs.openclaw.ai/tools/skills)** — installation guidée par assistant avec compétences groupées/gérées/espace de travail.

## Historique des étoiles

[![Star History Chart](https://api.star-history.com/svg?repos=openclaw/openclaw&type=date&legend=top-left)](https://www.star-history.com/#openclaw/openclaw&type=date&legend=top-left)

## Tout ce que nous avons construit jusqu'à présent

### Plateforme Core

- [Gateway WS control plane](https://docs.openclaw.ai/gateway) avec sessions, présence, config, cron, webhooks, [Control UI](https://docs.openclaw.ai/web), et [Canvas host](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui).
- [Interface CLI](https://docs.openclaw.ai/tools/agent-send) : gateway, agent, send, [wizard](https://docs.openclaw.ai/start/wizard), et [doctor](https://docs.openclaw.ai/gateway/doctor).
- [Runtime agent Pi](https://docs.openclaw.ai/concepts/agent) en mode RPC avec streaming d'outils et de blocs.
- [Modèle de session](https://docs.openclaw.ai/concepts/session) : `main` pour chats directs, isolation de groupe, modes d'activation, modes de file d'attente, réponse. Règles de groupe : [Groupes](https://docs.openclaw.ai/concepts/groups).
- [Pipeline média](https://docs.openclaw.ai/nodes/images) : images/audio/vidéo, hooks de transcription, limites de taille, cycle de vie fichiers temporaires. Détails audio : [Audio](https://docs.openclaw.ai/nodes/audio).

### Canaux

- [Canaux](https://docs.openclaw.ai/channels) : [WhatsApp](https://docs.openclaw.ai/channels/whatsapp) (Baileys), [Telegram](https://docs.openclaw.ai/channels/telegram) (grammY), [Slack](https://docs.openclaw.ai/channels/slack) (Bolt), [Discord](https://docs.openclaw.ai/channels/discord) (discord.js), [Google Chat](https://docs.openclaw.ai/channels/googlechat) (Chat API), [Signal](https://docs.openclaw.ai/channels/signal) (signal-cli), [BlueBubbles](https://docs.openclaw.ai/channels/bluebubbles) (iMessage, recommandé), [iMessage](https://docs.openclaw.ai/channels/imessage) (ancien imsg), [Microsoft Teams](https://docs.openclaw.ai/channels/msteams) (extension), [Matrix](https://docs.openclaw.ai/channels/matrix) (extension), [Zalo](https://docs.openclaw.ai/channels/zalo) (extension), [Zalo Personal](https://docs.openclaw.ai/channels/zalouser) (extension), [WebChat](https://docs.openclaw.ai/web/webchat).
- [Routage de groupe](https://docs.openclaw.ai/concepts/group-messages) : filtrage par mention, tags de réponse, découpage et routage par canal. Règles de canal : [Canaux](https://docs.openclaw.ai/channels).

### Apps + nœuds

- [App macOS](https://docs.openclaw.ai/platforms/macos) : contrôle barre de menu, [Réveil vocal](https://docs.openclaw.ai/nodes/voicewake)/PTT, [Mode conversation](https://docs.openclaw.ai/nodes/talk) overlay, [WebChat](https://docs.openclaw.ai/web/webchat), outils de débogage, contrôle [gateway à distance](https://docs.openclaw.ai/gateway/remote).
- [Nœud iOS](https://docs.openclaw.ai/platforms/ios) : [Canvas](https://docs.openclaw.ai/platforms/mac/canvas), [Réveil vocal](https://docs.openclaw.ai/nodes/voicewake), [Mode conversation](https://docs.openclaw.ai/nodes/talk), caméra, enregistrement écran, appairage Bonjour.
- [Nœud Android](https://docs.openclaw.ai/platforms/android) : [Canvas](https://docs.openclaw.ai/platforms/mac/canvas), [Mode conversation](https://docs.openclaw.ai/nodes/talk), caméra, enregistrement écran, SMS optionnel.
- [Mode nœud macOS](https://docs.openclaw.ai/nodes) : system.run/notify + exposition canvas/caméra.

### Outils + automatisation

- [Contrôle navigateur](https://docs.openclaw.ai/tools/browser) : Chrome/Chromium géré par openclaw, instantanés, actions, uploads, profils.
- [Canvas](https://docs.openclaw.ai/platforms/mac/canvas) : [A2UI](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui) push/reset, eval, instantané.
- [Nœuds](https://docs.openclaw.ai/nodes) : snap/clip caméra, enregistrement écran, [location.get](https://docs.openclaw.ai/nodes/location-command), notifications.
- [Cron + réveils](https://docs.openclaw.ai/automation/cron-jobs) ; [webhooks](https://docs.openclaw.ai/automation/webhook) ; [Gmail Pub/Sub](https://docs.openclaw.ai/automation/gmail-pubsub).
- [Plateforme de compétences](https://docs.openclaw.ai/tools/skills) : compétences groupées, gérées et d'espace de travail avec filtrage d'installation + UI.

### Runtime + sécurité

- [Routage de canal](https://docs.openclaw.ai/concepts/channel-routing), [politique de réessai](https://docs.openclaw.ai/concepts/retry), et [streaming/découpage](https://docs.openclaw.ai/concepts/streaming).
- [Présence](https://docs.openclaw.ai/concepts/presence), [indicateurs de frappe](https://docs.openclaw.ai/concepts/typing-indicators), et [suivi d'utilisation](https://docs.openclaw.ai/concepts/usage-tracking).
- [Modèles](https://docs.openclaw.ai/concepts/models), [basculement de modèle](https://docs.openclaw.ai/concepts/model-failover), et [nettoyage de session](https://docs.openclaw.ai/concepts/session-pruning).
- [Sécurité](https://docs.openclaw.ai/gateway/security) et [dépannage](https://docs.openclaw.ai/channels/troubleshooting).

### Ops + packaging

- [Control UI](https://docs.openclaw.ai/web) + [WebChat](https://docs.openclaw.ai/web/webchat) servis directement depuis la Gateway.
- [Tailscale Serve/Funnel](https://docs.openclaw.ai/gateway/tailscale) ou [tunnels SSH](https://docs.openclaw.ai/gateway/remote) avec auth token/mot de passe.
- [Mode Nix](https://docs.openclaw.ai/install/nix) pour config déclarative ; installations basées sur [Docker](https://docs.openclaw.ai/install/docker).
- [Doctor](https://docs.openclaw.ai/gateway/doctor) migrations, [logging](https://docs.openclaw.ai/logging).

## Comment ça marche (bref)

```
WhatsApp / Telegram / Slack / Discord / Google Chat / Signal / iMessage / BlueBubbles / Microsoft Teams / Matrix / Zalo / Zalo Personal / WebChat
               │
               ▼
┌───────────────────────────────┐
│            Gateway            │
│       (control plane)         │
│     ws://127.0.0.1:18789      │
└──────────────┬────────────────┘
               │
               ├─ Pi agent (RPC)
               ├─ CLI (openclaw …)
               ├─ WebChat UI
               ├─ App macOS
               └─ Nœuds iOS / Android
```

## Sous-systèmes clés

- **[Réseau WebSocket Gateway](https://docs.openclaw.ai/concepts/architecture)** — plan de contrôle WS unique pour clients, outils et événements (plus ops : [Gateway runbook](https://docs.openclaw.ai/gateway)).
- **[Exposition Tailscale](https://docs.openclaw.ai/gateway/tailscale)** — Serve/Funnel pour le tableau de bord Gateway + WS (accès distant : [Remote](https://docs.openclaw.ai/gateway/remote)).
- **[Contrôle navigateur](https://docs.openclaw.ai/tools/browser)** — Chrome/Chromium géré par openclaw avec contrôle CDP.
- **[Canvas + A2UI](https://docs.openclaw.ai/platforms/mac/canvas)** — espace de travail visuel piloté par agent (hôte A2UI : [Canvas/A2UI](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui)).
- **[Réveil vocal](https://docs.openclaw.ai/nodes/voicewake) + [Mode conversation](https://docs.openclaw.ai/nodes/talk)** — parole toujours active et conversation continue.
- **[Nœuds](https://docs.openclaw.ai/nodes)** — Canvas, snap/clip caméra, enregistrement écran, `location.get`, notifications, plus `system.run`/`system.notify` (macOS seulement).

## Accès Tailscale (Tableau de bord Gateway)

OpenClaw peut auto-configurer Tailscale **Serve** (tailnet uniquement) ou **Funnel** (public) tant que la Gateway reste liée au loopback. Configurez `gateway.tailscale.mode` :

- `off` : pas d'automatisation Tailscale (par défaut).
- `serve` : HTTPS tailnet uniquement via `tailscale serve` (utilise les en-têtes d'identité Tailscale par défaut).
- `funnel` : HTTPS public via `tailscale funnel` (nécessite auth par mot de passe partagé).

Notes :

- `gateway.bind` doit rester `loopback` quand Serve/Funnel est activé (OpenClaw force cela).
- Serve peut être forcé à demander un mot de passe en définissant `gateway.auth.mode: "password"` ou `gateway.auth.allowTailscale: false`.
- Funnel refuse de démarrer sauf si `gateway.auth.mode: "password"` est défini.
- Optionnel : `gateway.tailscale.resetOnExit` pour annuler Serve/Funnel à l'arrêt.

Détails : [Guide Tailscale](https://docs.openclaw.ai/gateway/tailscale) · [Surfaces Web](https://docs.openclaw.ai/web)

## Gateway à distance (Linux est super)

Il est tout à fait possible de faire tourner la Gateway sur une petite instance Linux. Les clients (macOS app, CLI, WebChat) peuvent se connecter via **Tailscale Serve/Funnel** ou **tunnels SSH**, et vous pouvez toujours appairer des nœuds (macOS/iOS/Android) pour exécuter des actions locales si nécessaire.

- **Gateway host** exécute l'outil exec et les connexions aux canaux par défaut.
- **Device nodes** exécutent les actions locales (`system.run`, caméra, enregistrement écran, notifications) via `node.invoke`.
  En bref : exec tourne là où est la Gateway ; les actions appareil tournent là où est l'appareil.

Détails : [Accès distant](https://docs.openclaw.ai/gateway/remote) · [Nœuds](https://docs.openclaw.ai/nodes) · [Sécurité](https://docs.openclaw.ai/gateway/security)

## Permissions macOS via le protocole Gateway

L'app macOS peut tourner en **mode nœud** et annonce ses capacités + map de permissions via le WebSocket Gateway (`node.list` / `node.describe`). Les clients peuvent alors exécuter des actions locales via `node.invoke` :

- `system.run` lance une commande locale et retourne stdout/stderr/code de sortie ; définissez `needsScreenRecording: true` pour requérir la permission d'enregistrement d'écran (sinon vous aurez `PERMISSION_MISSING`).
- `system.notify` publie une notification utilisateur et échoue si les notifications sont refusées.
- `canvas.*`, `camera.*`, `screen.record`, et `location.get` sont aussi routés via `node.invoke` et suivent le statut de permission TCC.

Bash élevé (permissions hôte) est séparé du TCC macOS :

- Utilisez `/elevated on|off` pour basculer l'accès élevé par session quand activé + autorisé.
- La Gateway persiste le basculement par session via `sessions.patch` (méthode WS) aux côtés de `thinkingLevel`, `verboseLevel`, `model`, `sendPolicy`, et `groupActivation`.

Détails : [Nœuds](https://docs.openclaw.ai/nodes) · [App macOS](https://docs.openclaw.ai/platforms/macos) · [Protocole Gateway](https://docs.openclaw.ai/concepts/architecture)

## Agent à Agent (outils sessions\_\*)

- Utilisez-les pour coordonner le travail entre sessions sans sauter entre les surfaces de chat.
- `sessions_list` — découvrir les sessions actives (agents) et leurs métadonnées.
- `sessions_history` — récupérer les logs de transcription pour une session.
- `sessions_send` — envoyer un message à une autre session ; ping-pong de réponse optionnel + étape d'annonce (`REPLY_SKIP`, `ANNOUNCE_SKIP`).

Détails : [Outils de session](https://docs.openclaw.ai/concepts/session-tool)

## Registre de compétences (ClawHub)

ClawHub est un registre de compétences minimal. Avec ClawHub activé, l'agent peut rechercher des compétences automatiquement et en récupérer de nouvelles au besoin.

[ClawHub](https://clawhub.com)

## Commandes de chat

Envoyez-les dans WhatsApp/Telegram/Slack/Google Chat/Microsoft Teams/WebChat (commandes de groupe réservées au propriétaire) :

- `/status` — statut de session compact (modèle + tokens, coût si disponible)
- `/new` ou `/reset` — réinitialiser la session
- `/compact` — contexte de session compact (résumé)
- `/think <level>` — off|minimal|low|medium|high|xhigh (modèles GPT-5.2 + Codex seulement)
- `/verbose on|off`
- `/usage off|tokens|full` — pied de page d'utilisation par réponse
- `/restart` — redémarrer la gateway (propriétaire uniquement dans les groupes)
- `/activation mention|always` — bascule d'activation de groupe (groupes uniquement)

## Apps (optionnel)

La Gateway seule offre une excellente expérience. Toutes les apps sont optionnelles et ajoutent des fonctionnalités supplémentaires.

Si vous prévoyez de construire/exécuter des apps compagnons, suivez les runbooks de plateforme ci-dessous.

### macOS (OpenClaw.app) (optionnel)

- Contrôle barre de menu pour la Gateway et la santé.
- Réveil vocal + overlay push-to-talk.
- WebChat + outils de débogage.
- Contrôle gateway à distance via SSH.

Note : builds signés requis pour que les permissions macOS persistent après reconstruction (voir `docs/mac/permissions.md`).

### Nœud iOS (optionnel)

- S'appaire comme un nœud via le Bridge.
- Transfert de déclencheur vocal + surface Canvas.
- Contrôlé via `openclaw nodes …`.

Runbook : [Connect iOS](https://docs.openclaw.ai/platforms/ios).

### Nœud Android (optionnel)

- S'appaire via le même Bridge + flux d'appairage qu'iOS.
- Expose commandes Canvas, Caméra, et Capture d'écran.
- Runbook : [Connect Android](https://docs.openclaw.ai/platforms/android).

## Espace de travail de l'agent + compétences

- Racine de l'espace de travail : `~/.openclaw/workspace` (configurable via `agents.defaults.workspace`).
- Fichiers de prompt injectés : `AGENTS.md`, `SOUL.md`, `TOOLS.md`.
- Compétences : `~/.openclaw/workspace/skills/<skill>/SKILL.md`.

## Configuration

`~/.openclaw/openclaw.json` minimal (modèle + défauts) :

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-6",
  },
}
```

[Référence de configuration complète (toutes les clés + exemples).](https://docs.openclaw.ai/gateway/configuration)

## Modèle de sécurité (important)

- **Défaut :** les outils tournent sur l'hôte pour la session **main**, donc l'agent a un accès complet quand c'est juste vous.
- **Sécurité groupe/canal :** définissez `agents.defaults.sandbox.mode: "non-main"` pour exécuter les **sessions non-main** (groupes/canaux) dans des sandbox Docker par session ; bash tourne alors dans Docker pour ces sessions.
- **Défauts Sandbox :** liste blanche `bash`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn` ; liste noire `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`.

Détails : [Guide de sécurité](https://docs.openclaw.ai/gateway/security) · [Docker + sandboxing](https://docs.openclaw.ai/install/docker) · [Config Sandbox](https://docs.openclaw.ai/gateway/configuration)

### [WhatsApp](https://docs.openclaw.ai/channels/whatsapp)

- Lier l'appareil : `pnpm openclaw channels login` (stocke les identifiants dans `~/.openclaw/credentials`).
- Liste blanche de qui peut parler à l'assistant via `channels.whatsapp.allowFrom`.
- Si `channels.whatsapp.groups` est défini, cela devient une liste blanche de groupes ; incluez `"*"` pour autoriser tout.

### [Telegram](https://docs.openclaw.ai/channels/telegram)

- Définissez `TELEGRAM_BOT_TOKEN` ou `channels.telegram.botToken` (env gagne).
- Optionnel : définissez `channels.telegram.groups` (avec `channels.telegram.groups."*".requireMention`) ; quand défini, c'est une liste blanche de groupes (incluez `"*"` pour autoriser tout). Aussi `channels.telegram.allowFrom` ou `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` au besoin.

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
- Optionnel : définissez `commands.native`, `commands.text`, ou `commands.useAccessGroups`, plus `channels.discord.allowFrom`, `channels.discord.guilds`, ou `channels.discord.mediaMaxMb` au besoin.

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
- Le serveur BlueBubbles tourne sur macOS ; la Gateway peut tourner sur macOS ou ailleurs.

### [iMessage (legacy)](https://docs.openclaw.ai/channels/imessage)

- Intégration héritée macOS uniquement via `imsg` (Messages doit être connecté).
- Si `channels.imessage.groups` est défini, cela devient une liste blanche de groupes ; incluez `"*"` pour autoriser tout.

### [Microsoft Teams](https://docs.openclaw.ai/channels/msteams)

- Configurez une app Teams + Bot Framework, puis ajoutez une section de config `msteams`.
- Liste blanche de qui peut parler via `msteams.allowFrom` ; accès groupe via `msteams.groupAllowFrom` ou `msteams.groupPolicy: "open"`.

### [WebChat](https://docs.openclaw.ai/web/webchat)

- Utilise le WebSocket Gateway ; pas de port/config WebChat séparé.

Contrôle navigateur (optionnel) :

```json5
{
  browser: {
    enabled: true,
    color: "#FF4500",
  },
}
```

## Docs

Utilisez ceci quand vous avez passé le flux d'onboarding et voulez une référence plus approfondie.

- [Commencez avec l'index des docs pour la navigation et "qu'est-ce qui est où".](https://docs.openclaw.ai)
- [Lisez la vue d'ensemble de l'architecture pour la gateway + modèle de protocole.](https://docs.openclaw.ai/concepts/architecture)
- [Utilisez la référence de configuration complète quand vous avez besoin de chaque clé et exemple.](https://docs.openclaw.ai/gateway/configuration)
- [Lancez la Gateway dans les règles de l'art avec le runbook opérationnel.](https://docs.openclaw.ai/gateway)
- [Apprenez comment fonctionnent l'UI de Contrôle/surfaces Web et comment les exposer en sécurité.](https://docs.openclaw.ai/web)
- [Comprenez l'accès distant via tunnels SSH ou tailnets.](https://docs.openclaw.ai/gateway/remote)
- [Suivez le flux de l'assistant d'onboarding pour une configuration guidée.](https://docs.openclaw.ai/start/wizard)
- [Câblez des déclencheurs externes via la surface webhook.](https://docs.openclaw.ai/automation/webhook)
- [Configurez les déclencheurs Gmail Pub/Sub.](https://docs.openclaw.ai/automation/gmail-pubsub)
- [Apprenez les détails du compagnon barre de menu macOS.](https://docs.openclaw.ai/platforms/mac/menu-bar)
- [Guides de plateforme : Windows (WSL2)](https://docs.openclaw.ai/platforms/windows), [Linux](https://docs.openclaw.ai/platforms/linux), [macOS](https://docs.openclaw.ai/platforms/macos), [iOS](https://docs.openclaw.ai/platforms/ios), [Android](https://docs.openclaw.ai/platforms/android)
- [Débuguez les échecs courants avec le guide de dépannage.](https://docs.openclaw.ai/channels/troubleshooting)
- [Révisez les conseils de sécurité avant d'exposer quoi que ce soit.](https://docs.openclaw.ai/gateway/security)

## Docs avancées (découverte + contrôle)

- [Découverte + transports](https://docs.openclaw.ai/gateway/discovery)
- [Bonjour/mDNS](https://docs.openclaw.ai/gateway/bonjour)
- [Appairage Gateway](https://docs.openclaw.ai/gateway/pairing)
- [README Gateway distante](https://docs.openclaw.ai/gateway/remote-gateway-readme)
- [UI de Contrôle](https://docs.openclaw.ai/web/control-ui)
- [Tableau de bord](https://docs.openclaw.ai/web/dashboard)

## Opérations & dépannage

- [Vérifications de santé](https://docs.openclaw.ai/gateway/health)
- [Verrou Gateway](https://docs.openclaw.ai/gateway/gateway-lock)
- [Processus d'arrière-plan](https://docs.openclaw.ai/gateway/background-process)
- [Dépannage navigateur (Linux)](https://docs.openclaw.ai/tools/browser-linux-troubleshooting)
- [Logging](https://docs.openclaw.ai/logging)

## Plongées en profondeur

- [Boucle agent](https://docs.openclaw.ai/concepts/agent-loop)
- [Présence](https://docs.openclaw.ai/concepts/presence)
- [Schémas TypeBox](https://docs.openclaw.ai/concepts/typebox)
- [Adaptateurs RPC](https://docs.openclaw.ai/reference/rpc)
- [File d'attente](https://docs.openclaw.ai/concepts/queue)

## Espace de travail & compétences

- [Config compétences](https://docs.openclaw.ai/tools/skills-config)
- [AGENTS par défaut](https://docs.openclaw.ai/reference/AGENTS.default)
- [Modèles : AGENTS](https://docs.openclaw.ai/reference/templates/AGENTS)
- [Modèles : BOOTSTRAP](https://docs.openclaw.ai/reference/templates/BOOTSTRAP)
- [Modèles : IDENTITY](https://docs.openclaw.ai/reference/templates/IDENTITY)
- [Modèles : SOUL](https://docs.openclaw.ai/reference/templates/SOUL)
- [Modèles : TOOLS](https://docs.openclaw.ai/reference/templates/TOOLS)
- [Modèles : USER](https://docs.openclaw.ai/reference/templates/USER)

## Internes plateforme

- [Setup dev macOS](https://docs.openclaw.ai/platforms/mac/dev-setup)
- [Barre de menu macOS](https://docs.openclaw.ai/platforms/mac/menu-bar)
- [Réveil vocal macOS](https://docs.openclaw.ai/platforms/mac/voicewake)
- [Nœud iOS](https://docs.openclaw.ai/platforms/ios)
- [Nœud Android](https://docs.openclaw.ai/platforms/android)
- [Windows (WSL2)](https://docs.openclaw.ai/platforms/windows)
- [App Linux](https://docs.openclaw.ai/platforms/linux)

## Hooks Email (Gmail)

- [docs.openclaw.ai/gmail-pubsub](https://docs.openclaw.ai/automation/gmail-pubsub)

## Molty

OpenClaw a été construit pour **Molty**, un assistant IA homard de l'espace. 🦞
par Peter Steinberger et la communauté.

- [openclaw.ai](https://openclaw.ai)
- [soul.md](https://soul.md)
- [steipete.me](https://steipete.me)
- [@openclaw](https://x.com/openclaw)

## Communauté

Voir [CONTRIBUTING.md](CONTRIBUTING.md) pour les directives, mainteneurs, et comment soumettre des PRs.
PRs IA/vibe-coded bienvenues ! 🤖

Remerciements spéciaux à [Mario Zechner](https://mariozechner.at/) pour son soutien et pour [pi-mono](https://github.com/badlogic/pi-mono).
Remerciements spéciaux à Adam Doppelt pour lobster.bot.
