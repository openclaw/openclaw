---
summary: "Référence complète du flux d'intégration CLI, configuration auth/modèle, sorties et internals"
read_when:
  - Vous avez besoin d'un comportement détaillé pour openclaw onboard
  - Vous déboguez les résultats d'intégration ou intégrez des clients d'intégration
title: "Référence d'intégration CLI"
sidebarTitle: "Référence CLI"
---

# Référence d'intégration CLI

Cette page est la référence complète pour `openclaw onboard`.
Pour le guide court, consultez [Assistant d'intégration (CLI)](/fr-FR/start/wizard).

## Ce que fait l'assistant

Le mode local (par défaut) vous guide à travers :

- Configuration du modèle et de l'authentification (abonnement OAuth OpenAI Code, clé API Anthropic ou token de configuration, plus les options MiniMax, GLM, Moonshot et AI Gateway)
- Emplacement de l'espace de travail et fichiers d'initialisation
- Paramètres de la passerelle (port, liaison, authentification, tailscale)
- Canaux et fournisseurs (Telegram, WhatsApp, Discord, Google Chat, plugin Mattermost, Signal)
- Installation du démon (LaunchAgent ou unité utilisateur systemd)
- Vérification de santé
- Configuration des compétences

Le mode distant configure cette machine pour se connecter à une passerelle ailleurs.
Il n'installe ni ne modifie rien sur l'hôte distant.

## Détails du flux local

<Steps>
  <Step title="Détection de configuration existante">
    - Si `~/.openclaw/openclaw.json` existe, choisissez Conserver, Modifier ou Réinitialiser.
    - Réexécuter l'assistant ne supprime rien sauf si vous choisissez explicitement Réinitialiser (ou passez `--reset`).
    - Si la configuration est invalide ou contient des clés héritées, l'assistant s'arrête et vous demande d'exécuter `openclaw doctor` avant de continuer.
    - La réinitialisation utilise `trash` et offre des portées :
      - Configuration uniquement
      - Configuration + identifiants + sessions
      - Réinitialisation complète (supprime également l'espace de travail)
  </Step>
  <Step title="Modèle et authentification">
    - La matrice d'options complète est dans [Options d'authentification et de modèle](#auth-and-model-options).
  </Step>
  <Step title="Espace de travail">
    - Par défaut `~/.openclaw/workspace` (configurable).
    - Initialise les fichiers d'espace de travail nécessaires pour le rituel d'initialisation de première exécution.
    - Disposition de l'espace de travail : [Espace de travail de l'agent](/fr-FR/concepts/agent-workspace).
  </Step>
  <Step title="Passerelle">
    - Demande le port, la liaison, le mode d'authentification et l'exposition tailscale.
    - Recommandé : gardez l'authentification par token activée même pour le loopback afin que les clients WS locaux doivent s'authentifier.
    - Désactivez l'authentification uniquement si vous faites entièrement confiance à chaque processus local.
    - Les liaisons non-loopback nécessitent toujours l'authentification.
  </Step>
  <Step title="Canaux">
    - [WhatsApp](/fr-FR/channels/whatsapp) : connexion QR optionnelle
    - [Telegram](/fr-FR/channels/telegram) : token de bot
    - [Discord](/fr-FR/channels/discord) : token de bot
    - [Google Chat](/fr-FR/channels/googlechat) : JSON de compte de service + audience webhook
    - Plugin [Mattermost](/fr-FR/channels/mattermost) : token de bot + URL de base
    - [Signal](/fr-FR/channels/signal) : installation optionnelle de `signal-cli` + configuration de compte
    - [BlueBubbles](/fr-FR/channels/bluebubbles) : recommandé pour iMessage ; URL du serveur + mot de passe + webhook
    - [iMessage](/fr-FR/channels/imessage) : chemin CLI `imsg` hérité + accès DB
    - Sécurité DM : par défaut c'est l'appairage. Le premier DM envoie un code ; approuvez via
      `openclaw pairing approve <canal> <code>` ou utilisez des listes d'autorisation.
  </Step>
  <Step title="Installation du démon">
    - macOS : LaunchAgent
      - Nécessite une session utilisateur connectée ; pour sans tête, utilisez un LaunchDaemon personnalisé (non fourni).
    - Linux et Windows via WSL2 : unité utilisateur systemd
      - L'assistant tente `loginctl enable-linger <utilisateur>` pour que la passerelle reste active après la déconnexion.
      - Peut demander sudo (écrit `/var/lib/systemd/linger`) ; il essaie d'abord sans sudo.
    - Sélection d'environnement d'exécution : Node (recommandé ; requis pour WhatsApp et Telegram). Bun n'est pas recommandé.
  </Step>
  <Step title="Vérification de santé">
    - Démarre la passerelle (si nécessaire) et exécute `openclaw health`.
    - `openclaw status --deep` ajoute des sondes de santé de la passerelle à la sortie de statut.
  </Step>
  <Step title="Compétences">
    - Lit les compétences disponibles et vérifie les exigences.
    - Vous permet de choisir le gestionnaire de nœuds : npm ou pnpm (bun non recommandé).
    - Installe les dépendances optionnelles (certaines utilisent Homebrew sur macOS).
  </Step>
  <Step title="Terminer">
    - Résumé et prochaines étapes, incluant les options d'application iOS, Android et macOS.
  </Step>
</Steps>

<Note>
Si aucune GUI n'est détectée, l'assistant imprime les instructions de transfert de port SSH pour l'interface de contrôle au lieu d'ouvrir un navigateur.
Si les ressources de l'interface de contrôle sont manquantes, l'assistant tente de les construire ; le repli est `pnpm ui:build` (installe automatiquement les dépendances UI).
</Note>

## Détails du mode distant

Le mode distant configure cette machine pour se connecter à une passerelle ailleurs.

<Info>
Le mode distant n'installe ni ne modifie rien sur l'hôte distant.
</Info>

Ce que vous définissez :

- URL de la passerelle distante (`ws://...`)
- Token si l'authentification de la passerelle distante est requise (recommandé)

<Note>
- Si la passerelle est en loopback uniquement, utilisez le tunneling SSH ou un tailnet.
- Indices de découverte :
  - macOS : Bonjour (`dns-sd`)
  - Linux : Avahi (`avahi-browse`)
</Note>

## Options d'authentification et de modèle

<AccordionGroup>
  <Accordion title="Clé API Anthropic (recommandée)">
    Utilise `ANTHROPIC_API_KEY` si présente ou demande une clé, puis la sauvegarde pour l'utilisation du démon.
  </Accordion>
  <Accordion title="OAuth Anthropic (CLI Claude Code)">
    - macOS : vérifie l'élément Keychain "Claude Code-credentials"
    - Linux et Windows : réutilise `~/.claude/.credentials.json` si présent

    Sur macOS, choisissez "Toujours autoriser" pour que les démarrages launchd ne bloquent pas.

  </Accordion>
  <Accordion title="Token Anthropic (collage de setup-token)">
    Exécutez `claude setup-token` sur n'importe quelle machine, puis collez le token.
    Vous pouvez le nommer ; vide utilise par défaut.
  </Accordion>
  <Accordion title="Abonnement OpenAI Code (réutilisation CLI Codex)">
    Si `~/.codex/auth.json` existe, l'assistant peut le réutiliser.
  </Accordion>
  <Accordion title="Abonnement OpenAI Code (OAuth)">
    Flux navigateur ; collez `code#state`.

    Définit `agents.defaults.model` sur `openai-codex/gpt-5.3-codex` quand le modèle n'est pas défini ou `openai/*`.

  </Accordion>
  <Accordion title="Clé API OpenAI">
    Utilise `OPENAI_API_KEY` si présente ou demande une clé, puis la sauvegarde dans
    `~/.openclaw/.env` pour que launchd puisse la lire.

    Définit `agents.defaults.model` sur `openai/gpt-5.1-codex` quand le modèle n'est pas défini, `openai/*`, ou `openai-codex/*`.

  </Accordion>
  <Accordion title="Clé API xAI (Grok)">
    Demande `XAI_API_KEY` et configure xAI comme fournisseur de modèle.
  </Accordion>
  <Accordion title="OpenCode Zen">
    Demande `OPENCODE_API_KEY` (ou `OPENCODE_ZEN_API_KEY`).
    URL de configuration : [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="Clé API (générique)">
    Stocke la clé pour vous.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    Demande `AI_GATEWAY_API_KEY`.
    Plus de détails : [Vercel AI Gateway](/fr-FR/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Demande l'ID de compte, l'ID de passerelle et `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    Plus de détails : [Cloudflare AI Gateway](/fr-FR/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    La configuration est auto-écrite.
    Plus de détails : [MiniMax](/fr-FR/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (compatible Anthropic)">
    Demande `SYNTHETIC_API_KEY`.
    Plus de détails : [Synthetic](/fr-FR/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot et Kimi Coding">
    Les configurations Moonshot (Kimi K2) et Kimi Coding sont auto-écrites.
    Plus de détails : [Moonshot AI (Kimi + Kimi Coding)](/fr-FR/providers/moonshot).
  </Accordion>
  <Accordion title="Fournisseur personnalisé">
    Fonctionne avec les points de terminaison compatibles OpenAI et Anthropic.

    Indicateurs non interactifs :
    - `--auth-choice custom-api-key`
    - `--custom-base-url`
    - `--custom-model-id`
    - `--custom-api-key` (optionnel ; repli sur `CUSTOM_API_KEY`)
    - `--custom-provider-id` (optionnel)
    - `--custom-compatibility <openai|anthropic>` (optionnel ; par défaut `openai`)

  </Accordion>
  <Accordion title="Ignorer">
    Laisse l'authentification non configurée.
  </Accordion>
</AccordionGroup>

Comportement du modèle :

- Choisit le modèle par défaut parmi les options détectées, ou entrez le fournisseur et le modèle manuellement.
- L'assistant exécute une vérification du modèle et avertit si le modèle configuré est inconnu ou manque d'authentification.

Chemins des identifiants et profils :

- Identifiants OAuth : `~/.openclaw/credentials/oauth.json`
- Profils d'authentification (clés API + OAuth) : `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
Astuce sans tête et serveur : complétez OAuth sur une machine avec navigateur, puis copiez
`~/.openclaw/credentials/oauth.json` (ou `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
sur l'hôte de la passerelle.
</Note>

## Sorties et internals

Champs typiques dans `~/.openclaw/openclaw.json` :

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (si Minimax choisi)
- `gateway.*` (mode, liaison, authentification, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Listes d'autorisation de canaux (Slack, Discord, Matrix, Microsoft Teams) lorsque vous acceptez pendant les prompts (les noms se résolvent en ID quand possible)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` écrit `agents.list[]` et `bindings` optionnels.

Les identifiants WhatsApp vont sous `~/.openclaw/credentials/whatsapp/<accountId>/`.
Les sessions sont stockées sous `~/.openclaw/agents/<agentId>/sessions/`.

<Note>
Certains canaux sont livrés comme plugins. Lorsqu'ils sont sélectionnés pendant l'intégration, l'assistant
demande d'installer le plugin (npm ou chemin local) avant la configuration du canal.
</Note>

RPC de l'assistant de passerelle :

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

Les clients (application macOS et interface de contrôle) peuvent afficher les étapes sans réimplémenter la logique d'intégration.

Comportement de configuration Signal :

- Télécharge la ressource de version appropriée
- La stocke sous `~/.openclaw/tools/signal-cli/<version>/`
- Écrit `channels.signal.cliPath` dans la configuration
- Les builds JVM nécessitent Java 21
- Les builds natifs sont utilisés quand disponibles
- Windows utilise WSL2 et suit le flux signal-cli Linux à l'intérieur de WSL

## Documentation connexe

- Centre d'intégration : [Assistant d'intégration (CLI)](/fr-FR/start/wizard)
- Automatisation et scripts : [Automatisation CLI](/fr-FR/start/wizard-cli-automation)
- Référence de commande : [`openclaw onboard`](/fr-FR/cli/onboard)
