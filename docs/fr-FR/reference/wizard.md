---
summary: "Référence complète wizard CLI onboarding : chaque étape, flag et champ config"
read_when:
  - Lookup étape ou flag wizard spécifique
  - Automatisation onboarding avec mode non-interactif
  - Debugging comportement wizard
title: "Référence Wizard Onboarding"
sidebarTitle: "Référence Wizard"
---

# Référence Wizard Onboarding

Référence complète pour wizard CLI `openclaw onboard`. Pour overview haut niveau, voir [Wizard Onboarding](/fr-FR/start/wizard).

## Détails flux (mode local)

<Steps>
  <Step title="Détection config existante">
    - Si `~/.openclaw/openclaw.json` existe, choisir **Keep / Modify / Reset**.
    - Re-run wizard ne wipe **rien** sauf choix explicite **Reset** (ou pass `--reset`).
    - Si config invalide ou contient clés legacy, wizard stoppe et demande run `openclaw doctor` avant continuer.
    - Reset utilise `trash` (jamais `rm`) et offre scopes :
      - Config seulement
      - Config + credentials + sessions
      - Reset complet (supprime aussi workspace)
  </Step>
  <Step title="Model/Auth">
    - **Clé API Anthropic (recommandé)** : utilise `ANTHROPIC_API_KEY` si présent ou prompt pour clé, puis sauvegarde pour usage daemon.
    - **OAuth Anthropic (Claude Code CLI)** : sur macOS wizard vérifie item Keychain "Claude Code-credentials" (choisir "Always Allow" pour starts launchd ne bloquent pas) ; sur Linux/Windows réutilise `~/.claude/.credentials.json` si présent.
    - **Token Anthropic (coller setup-token)** : run `claude setup-token` sur n'importe quelle machine, puis coller token (vous pouvez nommer ; blank = défaut).
    - **Abonnement OpenAI Code (Codex) (Codex CLI)** : si `~/.codex/auth.json` existe, wizard peut réutiliser.
    - **Abonnement OpenAI Code (Codex) (OAuth)** : flux browser ; coller `code#state`.
      - Définit `agents.defaults.model` vers `openai-codex/gpt-5.2` quand modèle unset ou `openai/*`.
    - **Clé API OpenAI** : utilise `OPENAI_API_KEY` si présent ou prompt clé, puis sauvegarde vers `~/.openclaw/.env` pour launchd peut lire.
    - **Clé API xAI (Grok)** : prompt `XAI_API_KEY` et configure xAI comme provider modèle.
    - **OpenCode Zen (proxy multi-model)** : prompt `OPENCODE_API_KEY` (ou `OPENCODE_ZEN_API_KEY`, obtenez à https://opencode.ai/auth).
    - **Vercel AI Gateway (proxy multi-model)** : prompt `AI_GATEWAY_API_KEY`.
    - Détail : [Vercel AI Gateway](/fr-FR/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway** : prompt Account ID, Gateway ID et `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - Détail : [Cloudflare AI Gateway](/fr-FR/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1** : config auto-écrite.
    - Détail : [MiniMax](/fr-FR/providers/minimax)
    - **Synthetic (compatible Anthropic)** : prompt `SYNTHETIC_API_KEY`.
    - Détail : [Synthetic](/fr-FR/providers/synthetic)
    - **Moonshot (Kimi K2)** : config auto-écrite.
    - **Kimi Coding** : config auto-écrite.
    - Détail : [Moonshot AI (Kimi + Kimi Coding)](/fr-FR/providers/moonshot)
    - **Skip** : pas auth configuré encore.
    - Choisir modèle défaut depuis options détectées (ou enter provider/model manuellement).
    - Wizard run check modèle et warn si modèle configuré inconnu ou auth manquant.
    - Credentials OAuth vivent dans `~/.openclaw/credentials/oauth.json` ; profils auth vivent dans `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (clés API + OAuth).
    - Plus détail : [/fr-FR/concepts/oauth](/fr-FR/concepts/oauth)
    <Note>
    Tip headless/serveur : compléter OAuth sur machine avec browser, puis copier
    `~/.openclaw/credentials/oauth.json` (ou `$OPENCLAW_STATE_DIR/credentials/oauth.json`) vers
    host passerelle.
    </Note>
  </Step>
  <Step title="Workspace">
    - Défaut `~/.openclaw/workspace` (configurable).
    - Seeds fichiers workspace nécessaires pour rituel bootstrap agent.
    - Layout workspace complet + guide backup : [Workspace Agent](/fr-FR/concepts/agent-workspace)
  </Step>
  <Step title="Passerelle">
    - Port, bind, mode auth, exposition tailscale.
    - Recommandation auth : garder **Token** même pour loopback pour clients WS locaux doivent authentifier.
    - Désactiver auth seulement si vous trustez complètement chaque processus local.
    - Binds non-loopback nécessitent toujours auth.
  </Step>
  <Step title="Canaux">
    - [WhatsApp](/fr-FR/channels/whatsapp) : login QR optionnel.
    - [Telegram](/fr-FR/channels/telegram) : token bot.
    - [Discord](/fr-FR/channels/discord) : token bot.
    - [Google Chat](/fr-FR/channels/googlechat) : JSON compte service + audience webhook.
    - [Mattermost](/fr-FR/channels/mattermost) (plugin) : token bot + URL base.
    - [Signal](/fr-FR/channels/signal) : install `signal-cli` optionnel + config compte.
    - [BlueBubbles](/fr-FR/channels/bluebubbles) : **recommandé pour iMessage** ; URL serveur + password + webhook.
    - [iMessage](/fr-FR/channels/imessage) : legacy path CLI `imsg` + accès DB.
    - Sécurité DM : défaut est pairing. Premier DM envoie code ; approuvez via `openclaw pairing approve <channel> <code>` ou utilisez allowlists.
  </Step>
  <Step title="Install daemon">
    - macOS : LaunchAgent
      - Nécessite session user logged-in ; pour headless, utilisez LaunchDaemon custom (pas shipped).
    - Linux (et Windows via WSL2) : unit systemd user
      - Wizard tente activer lingering via `loginctl enable-linger <user>` pour Passerelle reste up après logout.
      - Peut prompt sudo (écrit `/var/lib/systemd/linger`) ; essaye sans sudo d'abord.
    - **Sélection runtime :** Node (recommandé ; requis pour WhatsApp/Telegram). Bun **non recommandé**.
  </Step>
  <Step title="Check santé">
    - Démarre Passerelle (si nécessaire) et run `openclaw health`.
    - Tip : `openclaw status --deep` ajoute probes santé passerelle vers output status (nécessite passerelle joignable).
  </Step>
  <Step title="Skills (recommandé)">
    - Lit skills disponibles et vérifie requirements.
    - Laisse choisir manager node : **npm / pnpm** (bun non recommandé).
    - Installe dépendances optionnelles (certaines utilisent Homebrew sur macOS).
  </Step>
  <Step title="Finir">
    - Résumé + prochaines étapes, incluant apps iOS/Android/macOS pour features extra.
  </Step>
</Steps>

<Note>
Si pas GUI détecté, wizard imprime instructions port-forward SSH pour Control UI plutôt ouvrir browser.
Si assets Control UI manquants, wizard tente builder ; fallback `pnpm ui:build` (auto-installe deps UI).
</Note>

## Mode non-interactif

Utilisez `--non-interactive` pour automatiser ou scripter onboarding :

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

Ajoutez `--json` pour résumé machine-readable.

<Note>
`--json` n'implique **pas** mode non-interactif. Utilisez `--non-interactive` (et `--workspace`) pour scripts.
</Note>

## Ce que wizard écrit

Champs typiques dans `~/.openclaw/openclaw.json` :

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (si Minimax choisi)
- `gateway.*` (mode, bind, auth, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Allowlists canal (Slack/Discord/Matrix/Microsoft Teams) quand opt in durant prompts (noms résolvent vers IDs quand possible).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`

## Setup Signal (signal-cli)

Wizard peut installer `signal-cli` depuis releases GitHub :

- Télécharge asset release approprié.
- Stocke sous `~/.openclaw/tools/signal-cli/<version>/`.
- Écrit `channels.signal.cliPath` vers votre config.

Notes :

- Builds JVM nécessitent **Java 21**.
- Builds native utilisés quand disponibles.
- Windows utilise WSL2 ; install signal-cli suit flux Linux dans WSL.

## RPC wizard Passerelle

Passerelle expose flux wizard via RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`). Clients (app macOS, Control UI) peuvent render steps sans ré-implémenter logique onboarding.

## Flags CLI

```bash
# Mode
--mode <local|remote>
--non-interactive
--json
--reset

# Auth
--auth-choice <provider>
--anthropic-api-key <key>
--openai-api-key <key>
--gemini-api-key <key>
--xai-api-key <key>
--zai-api-key <key>

# Passerelle
--gateway-port <port>
--gateway-bind <loopback|lan|all>
--gateway-auth <token|none>

# Daemon
--install-daemon
--daemon-runtime <node|bun>
--skip-daemon

# Skills
--install-skills
--skip-skills
--node-manager <npm|pnpm|yarn>

# Workspace
--workspace <path>
```

Voir aussi :

- [Wizard Onboarding](/fr-FR/start/wizard)
- [Configuration](/fr-FR/gateway/configuration)
- [OAuth](/fr-FR/concepts/oauth)
- [Workspace](/fr-FR/concepts/agent-workspace)
