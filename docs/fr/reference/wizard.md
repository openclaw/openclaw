---
summary: "Référence complète de l’assistant d’onboarding CLI : chaque étape, option et champ de configuration"
read_when:
  - Recherche d'une étape ou d'un drapeau de l'assistant spécifique
  - Automatiser l’onboarding avec le mode non interactif
  - Comportement de l'assistant de débogage
title: "Référence de l’assistant d’onboarding"
sidebarTitle: "reference/wizard.md"
---

# Référence de l’assistant d’onboarding

Ceci est la référence complète de l’assistant CLI `openclaw onboard`.
Pour une vue d’ensemble, voir [Onboarding Wizard](/start/wizard).

## Détails du flux (mode local)

<Steps>
  <Step title="Existing config detection">
    - Si `~/.openclaw/openclaw.json` existe, choisissez **Conserver / Modifier / Réinitialiser**.
    - Relancer l’assistant ne supprime **rien** sauf si vous choisissez explicitement **Réinitialiser**
      (ou passez `--reset`).
    - Si la configuration est invalide ou contient des clés héritées, l’assistant s’arrête et vous demande
      d’exécuter `openclaw doctor` avant de continuer.
    - La réinitialisation utilise `trash` (jamais `rm`) et propose des portées :
      - Configuration uniquement
      - Configuration + identifiants + sessions
      - Réinitialisation complète (supprime aussi l’espace de travail)  
</Step>
  <Step title="Model/Auth">
    - **Clé API Anthropic (recommandé)** : utilise `ANTHROPIC_API_KEY` si présent ou demande une clé, puis l’enregistre pour l’utilisation par le daemon.
    - **OAuth Anthropic (Claude Code CLI)** : sur macOS, l’assistant vérifie l’élément Trousseau « Claude Code-credentials » (choisissez « Toujours autoriser » afin que les démarrages launchd ne soient pas bloqués) ; sur Linux/Windows, il réutilise `~/.claude/.credentials.json` s’il est présent.
    - **Jeton Anthropic (coller le setup-token)** : exécutez `claude setup-token` sur n’importe quelle machine, puis collez le jeton (vous pouvez le nommer ; vide = par défaut).
    - **Abonnement OpenAI Code (Codex) (Codex CLI)** : si `~/.codex/auth.json` existe, l’assistant peut le réutiliser.
    - **Abonnement OpenAI Code (Codex) (OAuth)** : flux navigateur ; collez le `code#state`.
      - Définit `agents.defaults.model` sur `openai-codex/gpt-5.2` lorsque le modèle n’est pas défini ou vaut `openai/*`.
    - **Clé API OpenAI** : utilise `OPENAI_API_KEY` si présent ou demande une clé, puis l’enregistre dans `~/.openclaw/.env` afin que launchd puisse la lire.
    - **xAI (Grok) API key**: invite pour `XAI_API_KEY` et configure xAI en tant que fournisseur de modèles.
    - **OpenCode Zen (proxy multi‑modèles)** : demande `OPENCODE_API_KEY` (ou `OPENCODE_ZEN_API_KEY`, à obtenir sur https://opencode.ai/auth).
    - **Clé API** : enregistre la clé pour vous.
    - **Vercel AI Gateway (proxy multi‑modèles)** : demande `AI_GATEWAY_API_KEY`.
    - Plus de détails : [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway** : demande l’ID de compte, l’ID de Gateway et `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - Plus de détails : [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1** : la configuration est écrite automatiquement.
    - Plus de détails : [MiniMax](/providers/minimax)
    - **Synthetic (compatible Anthropic)** : demande `SYNTHETIC_API_KEY`.
    - Plus de détails : [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)** : la configuration est écrite automatiquement.
    - **Kimi Coding** : la configuration est écrite automatiquement.
    - Plus de détails : [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Ignorer** : aucune authentification configurée pour l’instant.
    - Choisissez un modèle par défaut parmi les options détectées (ou saisissez fournisseur/modèle manuellement).
    - L’assistant exécute une vérification du modèle et avertit si le modèle configuré est inconnu ou si l’authentification manque.
    - Les identifiants OAuth se trouvent dans `~/.openclaw/credentials/oauth.json` ; les profils d’authentification se trouvent dans `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (clés API + OAuth).
    - Plus de détails : [/concepts/oauth](/concepts/oauth)    
<Note>
    Astuce headless/serveur : terminez l’OAuth sur une machine avec un navigateur, puis copiez
    `~/.openclaw/credentials/oauth.json` (ou `$OPENCLAW_STATE_DIR/credentials/oauth.json`) vers l’hôte de la Gateway (passerelle).
    </Note>
  </Step>
  <Step title="Workspace">
    - `~/.openclaw/workspace` par défaut (configurable).
    - Initialise les fichiers d’espace de travail nécessaires au rituel de démarrage de l’agent.
    - Disposition complète de l’espace de travail + guide de sauvegarde : [Agent workspace](/concepts/agent-workspace)  
</Step>
  <Step title="Gateway">
    - Port, liaison, mode d’authentification, exposition Tailscale.
    - Recommandation d’authentification : conservez **Token** même en loopback afin que les clients WS locaux doivent s’authentifier.
    - Désactivez l’authentification uniquement si vous faites entièrement confiance à chaque processus local.
    - Les liaisons non‑loopback nécessitent toujours une authentification.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp) : connexion QR optionnelle.
    - [Telegram](/channels/telegram) : jeton de bot.
    - [Discord](/channels/discord) : jeton de bot.
    - [Google Chat](/channels/googlechat) : JSON de compte de service + audience webhook.
    - [Mattermost](/channels/mattermost) (plugin) : jeton de bot + URL de base.
    - [Signal](/channels/signal) : installation `signal-cli` optionnelle + configuration du compte.
    - [BlueBubbles](/channels/bluebubbles) : **recommandé pour iMessage** ; URL du serveur + mot de passe + webhook.
    - [iMessage](/channels/imessage) : chemin CLI `imsg` hérité + accès à la base de données.
    - Sécurité des Messages prives : le mode par défaut est l’appairage. Le premier Message prive envoie un code ; approuvez via `openclaw pairing approve <channel><code>` ou utilisez des listes d’autorisation.
  </Step><code>` ou utilisez des listes d’autorisation.
  </Step>
  <Step title="Installation du daemon">
    - macOS : LaunchAgent
      - Nécessite une session utilisateur connectée ; pour le headless, utilisez un LaunchDaemon personnalisé (non fourni).
    - Linux (et Windows via WSL2) : unité utilisateur systemd
      - L’assistant tente d’activer le lingering via `loginctl enable-linger <user>` afin que la Gateway (passerelle) reste active après la déconnexion.
      - Peut demander sudo (écrit `/var/lib/systemd/linger`) ; il essaie d’abord sans sudo.
    - **Sélection du runtime :** Node (recommandé ; requis pour WhatsApp/Telegram). Bun n’est **pas recommandé**.
  </Step>
  <Step title="Vérification de santé">
    - Démarre la Gateway (passerelle) (si nécessaire) et exécute `openclaw health`.
    - Astuce : `openclaw status --deep` ajoute des sondes de santé de la Gateway à la sortie d’état (nécessite une Gateway accessible).
  </Step>
  <Step title="Skills (recommandé)">
    - Lit les Skills disponibles et vérifie les prérequis.
    - Vous permet de choisir un gestionnaire Node : **npm / pnpm** (bun non recommandé).
    - Installe les dépendances optionnelles (certaines utilisent Homebrew sur macOS).
  </Step>
  <Step title="Fin">
    - Récapitulatif + étapes suivantes, y compris les applications iOS/Android/macOS pour des fonctionnalités supplémentaires.
  </Step>
</Steps>

<Note>
Si aucune interface graphique n’est détectée, l’assistant affiche des instructions de redirection de port SSH pour l’interface de contrôle au lieu d’ouvrir un navigateur.
Si les ressources de l’interface de contrôle sont manquantes, l’assistant tente de les construire ; la solution de repli est `pnpm ui:build` (installe automatiquement les dépendances UI).
</Note>

## Mode non interactif

Utilisez `--non-interactive` pour automatiser ou scripter l’onboarding :

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

Ajoutez `--json` pour un récapitulatif lisible par machine.

<Note>
`--json` n’implique **pas** le mode non interactif. Utilisez `--non-interactive` (et `--workspace`) pour les scripts.
</Note>

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

### Ajouter un agent (non interactif)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## RPC de l’assistant de la Gateway

La Gateway (passerelle) expose le flux de l’assistant via RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Les clients (application macOS, interface de contrôle) peuvent afficher les étapes sans réimplémenter la logique d’onboarding.

## Configuration Signal (signal-cli)

L’assistant peut installer `signal-cli` depuis les releases GitHub :

- Télécharge la ressource de release appropriée.
- La stocke sous `~/.openclaw/tools/signal-cli/<version>/`.
- Écrit `channels.signal.cliPath` dans votre configuration.

Notes :

- Les builds JVM nécessitent **Java 21**.
- Les builds natives sont utilisées lorsqu’elles sont disponibles.
- Windows utilise WSL2 ; l’installation de signal-cli suit le flux Linux à l’intérieur de WSL.

## Ce que l’assistant écrit

Champs typiques dans `~/.openclaw/openclaw.json` :

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (si Minimax est choisi)
- `gateway.*` (mode, liaison, auth, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Listes d’autorisation de canaux (Slack/Discord/Matrix/Microsoft Teams) lorsque vous optez pour cette option pendant les invites (les noms sont résolus en ID lorsque possible).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` écrit `agents.list[]` et `bindings` optionnel.

Les identifiants WhatsApp se trouvent sous `~/.openclaw/credentials/whatsapp/<accountId>/`.
Les sessions sont stockées sous `~/.openclaw/agents/<agentId>/sessions/`.

Certains canaux sont fournis sous forme de plugins. Lorsque vous en sélectionnez un pendant l’onboarding, l’assistant
vous proposera de l’installer (npm ou un chemin local) avant qu’il puisse être configuré.

## Documentation associée

- Vue d’ensemble de l’assistant : [Onboarding Wizard](/start/wizard)
- Onboarding de l’application macOS : [Onboarding](/start/onboarding)
- Référence de configuration : [Gateway configuration](/gateway/configuration)
- Fournisseurs : [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (hérité)
- Skills : [Skills](/tools/skills), [configuration des Skills](/tools/skills-config)
