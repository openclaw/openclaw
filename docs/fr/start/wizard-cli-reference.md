---
summary: "Reference complete pour le flux de prise en main CLI, la configuration auth/modele, les sorties et les details internes"
read_when:
  - Vous avez besoin du comportement detaille pour openclaw onboard
  - Vous depannez les resultats de la prise en main ou integrez des clients de prise en main
title: "Reference de la prise en main CLI"
sidebarTitle: "Reference CLI"
---

# Reference de la prise en main CLI

Cette page est la reference complete pour `openclaw onboard`.
Pour le guide court, voir [Assistant de prise en main (CLI)](/start/wizard).

## Ce que fait l'assistant

Le mode local (par defaut) vous guide a travers :

- La configuration du modele et de l’authentification (OAuth OpenAI Code subscription, cle API Anthropic ou jeton de configuration, ainsi que MiniMax, GLM, Moonshot et les options AI Gateway)
- L’emplacement de l’espace de travail et les fichiers de bootstrap
- Les parametres de la Gateway (passerelle) (port, bind, auth, Tailscale)
- Les canaux et fournisseurs (Telegram, WhatsApp, Discord, Google Chat, plugin Mattermost, Signal)
- L’installation du daemon (LaunchAgent ou unite utilisateur systemd)
- Bilan de santé
- La configuration des Skills

Le mode distant configure cette machine pour se connecter a une Gateway (passerelle) situee ailleurs.
Il n’installe ni ne modifie quoi que ce soit sur l’hote distant.

## Details du flux local

<Steps>
  <Step title="Existing config detection">
    - Si `~/.openclaw/openclaw.json` existe, choisissez Conserver, Modifier ou Reinitialiser.
    - Relancer l’assistant n’efface rien sauf si vous choisissez explicitement Reinitialiser (ou passez `--reset`).
    - Si la configuration est invalide ou contient des cles heritees, l’assistant s’arrete et vous demande d’executer `openclaw doctor` avant de continuer.
    - La reinitialisation utilise `trash` et propose des portees :
      - Configuration uniquement
      - Configuration + informations d’identification + sessions
      - Reinitialisation complete (supprime aussi l’espace de travail)  
</Step>
  <Step title="Model and auth">
    - La matrice complete des options est disponible dans [Options d’authentification et de modele](#auth-and-model-options).
  </Step>
  <Step title="Workspace">
    - Par defaut `~/.openclaw/workspace` (configurable).
    - Initialise les fichiers d’espace de travail necessaires au rituel de bootstrap du premier lancement.
    - Structure de l’espace de travail : [Espace de travail de l’agent](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Invite a definir le port, le bind, le mode d’authentification et l’exposition Tailscale.
    - Recommande : conserver l’authentification par jeton activee meme pour le loopback afin que les clients WS locaux doivent s’authentifier.
    - Desactivez l’authentification uniquement si vous faites pleinement confiance a chaque processus local.
    - Les binds non loopback exigent toujours l’authentification.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp) : connexion QR optionnelle
    - [Telegram](/channels/telegram) : jeton de bot
    - [Discord](/channels/discord) : jeton de bot
    - [Google Chat](/channels/googlechat) : JSON de compte de service + audience de webhook
    - Plugin [Mattermost](/channels/mattermost) : jeton de bot + URL de base
    - [Signal](/channels/signal) : installation optionnelle de `signal-cli` + configuration du compte
    - [BlueBubbles](/channels/bluebubbles) : recommande pour iMessage ; URL du serveur + mot de passe + webhook
    - [iMessage](/channels/imessage) : chemin CLI herite `imsg` + acces a la base de donnees
    - Securite des Messages prives : par defaut, appairage. Le premier Message prive envoie un code ; approuvez via
      `openclaw pairing approve <channel><code>` ou utilisez des listes d’autorisation.
  </Step><code>` ou utilisez des listes d’autorisation.
  </Step>
  <Step title="Installation du daemon">
    - macOS : LaunchAgent
      - Necessite une session utilisateur connectee ; pour le sans tete, utilisez un LaunchDaemon personnalise (non fourni).
    - Linux et Windows via WSL2 : unite utilisateur systemd
      - L’assistant tente `loginctl enable-linger <user>` afin que la Gateway reste active apres deconnexion.
      - Peut demander sudo (ecrit `/var/lib/systemd/linger`) ; il essaie d’abord sans sudo.
    - Selection du runtime : Node (recommande ; requis pour WhatsApp et Telegram). Bun n’est pas recommande.
  </Step>
  <Step title="Controle d’etat">
    - Demarre la Gateway (si necessaire) et execute `openclaw health`.
    - `openclaw status --deep` ajoute des sondes d’etat de la Gateway a la sortie de statut.
  </Step>
  <Step title="Skills">
    - Lit les Skills disponibles et verifie les prerequis.
    - Vous permet de choisir le gestionnaire Node : npm ou pnpm (bun non recommande).
    - Installe les dependances optionnelles (certaines utilisent Homebrew sur macOS).
  </Step>
  <Step title="Fin">
    - Resume et prochaines etapes, y compris les options d’applications iOS, Android et macOS.
  </Step>
</Steps>

<Note>
Si aucune interface graphique n’est detectee, l’assistant affiche des instructions de redirection de port SSH pour l’interface Control UI au lieu d’ouvrir un navigateur.
Si les ressources de Control UI sont manquantes, l’assistant tente de les construire ; la solution de repli est `pnpm ui:build` (installe automatiquement les dependances UI).
</Note>

## Details du mode distant

Le mode distant configure cette machine pour se connecter a une Gateway situee ailleurs.

<Info>
Le mode distant n’installe ni ne modifie quoi que ce soit sur l’hote distant.
</Info>

Ce que vous configurez :

- URL de la Gateway distante (`ws://...`)
- Jeton si l’authentification de la Gateway distante est requise (recommande)

<Note>
- Si la Gateway est limitee au loopback, utilisez un tunnel SSH ou un tailnet.
- Indices de decouverte :
  - macOS : Bonjour (`dns-sd`)
  - Linux : Avahi (`avahi-browse`)
</Note>

## Options d’authentification et de modele

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    Utilise `ANTHROPIC_API_KEY` si present ou demande une cle, puis l’enregistre pour l’usage du daemon.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS : verifie l’element du Trousseau « Claude Code-credentials »
    - Linux et Windows : reutilise `~/.claude/.credentials.json` si present

    ```
    Sur macOS, choisissez « Toujours autoriser » afin que les demarrages via launchd ne soient pas bloques.
    ```

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    Executez `claude setup-token` sur n’importe quelle machine, puis collez le jeton.
    Vous pouvez le nommer ; vide utilise la valeur par defaut.
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    Si `~/.codex/auth.json` existe, l’assistant peut le reutiliser.
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    Flux via navigateur ; collez `code#state`.

    ```
    Definit `agents.defaults.model` sur `openai-codex/gpt-5.3-codex` lorsque le modele n’est pas defini ou vaut `openai/*`.
    ```

  </Accordion>
  <Accordion title="OpenAI API key">
    Utilise `OPENAI_API_KEY` si present ou demande une cle, puis l’enregistre dans
    `~/.openclaw/.env` afin que launchd puisse la lire.

    ```
    Definit `agents.defaults.model` sur `openai/gpt-5.1-codex` lorsque le modele n’est pas defini, vaut `openai/*` ou `openai-codex/*`.
    ```

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    Invite pour `XAI_API_KEY` et configure xAI en tant que fournisseur de modèles.
  </Accordion>
  <Accordion title="OpenCode Zen">
    Invite a fournir `OPENCODE_API_KEY` (ou `OPENCODE_ZEN_API_KEY`).
    URL de configuration : [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">Stocke la clé pour vous.</Accordion>
  <Accordion title="Vercel AI Gateway">
    Invite a fournir `AI_GATEWAY_API_KEY`.
    Plus de details : [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Invite a fournir l’ID de compte, l’ID de Gateway et `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    Plus de details : [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    La configuration est ecrite automatiquement.
    Plus de details : [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    Invite a fournir `SYNTHETIC_API_KEY`.
    Plus de details : [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    Les configurations Moonshot (Kimi K2) et Kimi Coding sont ecrites automatiquement.
    Plus de details : [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Skip">
    Laisse l’authentification non configuree.
  </Accordion>
</AccordionGroup>

Comportement du modele :

- Choisissez le modele par defaut a partir des options detectees, ou saisissez manuellement le fournisseur et le modele.
- L’assistant execute une verification du modele et avertit si le modele configure est inconnu ou si l’authentification est manquante.

Chemins des informations d’identification et des profils :

- Informations d’identification OAuth : `~/.openclaw/credentials/oauth.json`
- Profils d’authentification (cles API + OAuth) : `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
Conseil sans tete et serveur : effectuez l’OAuth sur une machine avec navigateur, puis copiez
`~/.openclaw/credentials/oauth.json` (ou `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
vers l’hote de la Gateway.
</Note>

## Sorties et details internes

Champs typiques dans `~/.openclaw/openclaw.json` :

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (si Minimax est choisi)
- `gateway.*` (mode, bind, auth, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Listes d’autorisation des canaux (Slack, Discord, Matrix, Microsoft Teams) lorsque vous acceptez lors des invites (les noms sont resolus en identifiants lorsque possible)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` ecrit `agents.list[]` et l’optionnel `bindings`.

Les informations d’identification WhatsApp se trouvent sous `~/.openclaw/credentials/whatsapp/<accountId>/`.
Les sessions sont stockees sous `~/.openclaw/agents/<agentId>/sessions/`.

<Note>
Certains canaux sont fournis sous forme de plugins. Lorsqu’ils sont selectionnes pendant la prise en main, l’assistant
demande d’installer le plugin (npm ou chemin local) avant la configuration du canal.
</Note>

RPC de l’assistant Gateway :

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

Les clients (application macOS et Control UI) peuvent afficher les etapes sans reimplementer la logique de prise en main.

Comportement de configuration Signal :

- Telecharge la ressource de version appropriee
- La stocke sous `~/.openclaw/tools/signal-cli/<version>/`
- Ecrit `channels.signal.cliPath` dans la configuration
- Les builds JVM necessitent Java 21
- Les builds natifs sont utilises lorsqu’ils sont disponibles
- Windows utilise WSL2 et suit le flux signal-cli Linux a l’interieur de WSL

## Documents associes

- Hub de prise en main : [Assistant de prise en main (CLI)](/start/wizard)
- Automatisation et scripts : [Automatisation CLI](/start/wizard-cli-automation)
- Reference des commandes : [`openclaw onboard`](/cli/onboard)
