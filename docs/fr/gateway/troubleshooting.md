---
summary: "Guide de depannage rapide pour les defaillances courantes d’OpenClaw"
read_when:
  - Enquete sur des problemes ou defaillances a l’execution
title: "Depannage"
x-i18n:
  source_path: gateway/troubleshooting.md
  source_hash: a07bb06f0b5ef568
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:02:41Z
---

# Depannage 🔧

Lorsque OpenClaw se comporte mal, voici comment le corriger.

Commencez par la [Premiers pas](/help/faq#first-60-seconds-if-somethings-broken) de la FAQ si vous voulez simplement une recette de triage rapide. Cette page approfondit les defaillances a l’execution et les diagnostics.

Raccourcis specifiques aux fournisseurs : [/channels/troubleshooting](/channels/troubleshooting)

## Statut et diagnostics

Commandes de triage rapide (dans l’ordre) :

| Commande                           | Ce que cela vous indique                                                                                                     | Quand l’utiliser                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `openclaw status`                  | Resume local : OS + mise a jour, joignabilite/mode de la passerelle, service, agents/sessions, etat de la config fournisseur | Premier controle, vue d’ensemble rapide                           |
| `openclaw status --all`            | Diagnostic local complet (lecture seule, copiable, plutot sur) incluant la fin des logs                                      | Quand vous devez partager un rapport de debug                     |
| `openclaw status --deep`           | Execute des verifications de sante de la passerelle (incl. sondes fournisseurs ; passerelle joignable requise)               | Quand « configure » ne veut pas dire « fonctionne »               |
| `openclaw gateway probe`           | Decouverte + joignabilite de la passerelle (cibles locales + distantes)                                                      | Quand vous soupconnez de sonder la mauvaise passerelle            |
| `openclaw channels status --probe` | Interroge la passerelle en cours pour l’etat des canaux (et sonde en option)                                                 | Quand la passerelle est joignable mais les canaux dysfonctionnent |
| `openclaw gateway status`          | Etat du superviseur (launchd/systemd/schtasks), PID/fin d’execution, derniere erreur de la passerelle                        | Quand le service « semble charge » mais rien ne tourne            |
| `openclaw logs --follow`           | Logs en direct (meilleur signal pour les problemes a l’execution)                                                            | Quand vous avez besoin de la raison exacte de l’echec             |

**Partage de sortie :** preferez `openclaw status --all` (il masque les jetons). Si vous collez `openclaw status`, envisagez de definir `OPENCLAW_SHOW_SECRETS=0` d’abord (apercus de jetons).

Voir aussi : [Health checks](/gateway/health) et [Logging](/logging).

## Problemes courants

### No API key found for provider "anthropic"

Cela signifie que le **stockage d’authentification de l’agent est vide** ou qu’il manque les informations d’identification Anthropic.
L’authentification est **par agent**, donc un nouvel agent n’heritera pas des cles de l’agent principal.

Options de correction :

- Relancez la prise en main et choisissez **Anthropic** pour cet agent.
- Ou collez un setup-token sur l’**hote de la Gateway (passerelle)** :
  ```bash
  openclaw models auth setup-token --provider anthropic
  ```
- Ou copiez `auth-profiles.json` du repertoire de l’agent principal vers celui du nouvel agent.

Verifier :

```bash
openclaw models status
```

### OAuth token refresh failed (Anthropic Claude subscription)

Cela signifie que le jeton OAuth Anthropic stocke a expire et que le rafraichissement a echoue.
Si vous etes sur un abonnement Claude (sans cle API), la correction la plus fiable consiste a
passer a un **Claude Code setup-token** et a le coller sur l’**hote de la Gateway (passerelle)**.

**Recommande (setup-token) :**

```bash
# Run on the gateway host (paste the setup-token)
openclaw models auth setup-token --provider anthropic
openclaw models status
```

Si vous avez genere le jeton ailleurs :

```bash
openclaw models auth paste-token --provider anthropic
openclaw models status
```

Plus de details : [Anthropic](/providers/anthropic) et [OAuth](/concepts/oauth).

### L’interface de controle echoue en HTTP (« device identity required » / « connect failed »)

Si vous ouvrez le tableau de bord en HTTP simple (par ex. `http://<lan-ip>:18789/` ou
`http://<tailscale-ip>:18789/`), le navigateur s’execute dans un **contexte non securise** et
bloque WebCrypto ; l’identite de l’appareil ne peut donc pas etre generee.

**Correction :**

- Preferez HTTPS via [Tailscale Serve](/gateway/tailscale).
- Ou ouvrez localement sur l’hote de la Gateway (passerelle) : `http://127.0.0.1:18789/`.
- Si vous devez rester en HTTP, activez `gateway.controlUi.allowInsecureAuth: true` et
  utilisez un jeton de passerelle (jeton uniquement ; pas d’identite d’appareil/appairage). Voir
  [Control UI](/web/control-ui#insecure-http).

### CI Secrets Scan Failed

Cela signifie que `detect-secrets` a trouve de nouveaux candidats qui ne sont pas encore dans la reference.
Suivez [Secret scanning](/gateway/security#secret-scanning-detect-secrets).

### Service installe mais rien ne tourne

Si le service de la passerelle est installe mais que le processus se termine immediatement, le service
peut apparaitre « charge » alors que rien ne tourne.

**Verifier :**

```bash
openclaw gateway status
openclaw doctor
```

Doctor/service affichera l’etat a l’execution (PID/derniere sortie) et des indices dans les logs.

**Logs :**

- Prefere : `openclaw logs --follow`
- Logs fichier (toujours) : `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (ou votre `logging.file` configure)
- macOS LaunchAgent (si installe) : `$OPENCLAW_STATE_DIR/logs/gateway.log` et `gateway.err.log`
- Linux systemd (si installe) : `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Windows : `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

**Activer plus de journalisation :**

- Augmenter le niveau des logs fichier (JSONL persistant) :
  ```json
  { "logging": { "level": "debug" } }
  ```
- Augmenter la verbosite console (sortie TTY uniquement) :
  ```json
  { "logging": { "consoleLevel": "debug", "consoleStyle": "pretty" } }
  ```
- Astuce rapide : `--verbose` n’affecte que la sortie **console**. Les logs fichier restent controles par `logging.level`.

Voir [/logging](/logging) pour une vue d’ensemble complete des formats, de la config et de l’acces.

### « Gateway start blocked: set gateway.mode=local »

Cela signifie que la configuration existe mais que `gateway.mode` n’est pas defini (ou n’est pas `local`), donc la
Gateway (passerelle) refuse de demarrer.

**Correction (recommandee) :**

- Lancez l’assistant et definissez le mode d’execution de la Gateway (passerelle) sur **Local** :
  ```bash
  openclaw configure
  ```
- Ou definissez-le directement :
  ```bash
  openclaw config set gateway.mode local
  ```

**Si vous vouliez plutot executer une Gateway (passerelle) distante :**

- Definissez une URL distante et conservez `gateway.mode=remote` :
  ```bash
  openclaw config set gateway.mode remote
  openclaw config set gateway.remote.url "wss://gateway.example.com"
  ```

**Ad-hoc/dev uniquement :** passez `--allow-unconfigured` pour demarrer la passerelle sans
`gateway.mode=local`.

**Pas encore de fichier de config ?** Executez `openclaw setup` pour creer une configuration de depart, puis relancez
la passerelle.

### Environnement du service (PATH + runtime)

Le service de la passerelle s’execute avec un **PATH minimal** afin d’eviter les scories de shell/gestionnaire :

- macOS : `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
- Linux : `/usr/local/bin`, `/usr/bin`, `/bin`

Cela exclut intentionnellement les gestionnaires de versions (nvm/fnm/volta/asdf) et les gestionnaires
de paquets (pnpm/npm) car le service ne charge pas l’initialisation de votre shell. Les variables
d’execution comme `DISPLAY` doivent vivre dans `~/.openclaw/.env` (charge tres tot par la
passerelle).
Exec s’execute sur `host=gateway` et fusionne votre `PATH` de shell de connexion dans l’environnement d’exec ;
ainsi, des outils manquants signifient generalement que votre init de shell ne les exporte pas (ou
definissez `tools.exec.pathPrepend`). Voir [/tools/exec](/tools/exec).

Les canaux WhatsApp + Telegram necessitent **Node** ; Bun n’est pas pris en charge. Si votre
service a ete installe avec Bun ou un chemin Node gere par version, executez `openclaw doctor`
pour migrer vers une installation Node systeme.

### Skill sans cle API dans le sandbox

**Symptome :** le Skill fonctionne sur l’hote mais echoue dans le sandbox avec une cle API manquante.

**Pourquoi :** l’exec en sandbox s’execute dans Docker et **n’herite pas** des `process.env` de l’hote.

**Correction :**

- definir `agents.defaults.sandbox.docker.env` (ou par agent `agents.list[].sandbox.docker.env`)
- ou integrer la cle dans votre image sandbox personnalisee
- puis executer `openclaw sandbox recreate --agent <id>` (ou `--all`)

### Service en cours mais port a l’ecoute absent

Si le service indique **en cours** mais que rien n’ecoute sur le port de la passerelle,
la Gateway (passerelle) a probablement refuse de se lier.

**Ce que signifie « en cours » ici**

- `Runtime: running` signifie que votre superviseur (launchd/systemd/schtasks) pense que le processus est vivant.
- `RPC probe` signifie que la CLI a effectivement pu se connecter au WebSocket de la passerelle et appeler `status`.
- Fiez-vous toujours a `Probe target:` + `Config (service):` comme lignes « qu’avons-nous reellement essaye ? ».

**Verifier :**

- `gateway.mode` doit etre `local` pour `openclaw gateway` et le service.
- Si vous avez defini `gateway.mode=remote`, la **CLI par defaut** pointe vers une URL distante. Le service peut toujours tourner localement, mais votre CLI peut sonder le mauvais endroit. Utilisez `openclaw gateway status` pour voir le port resolu du service + la cible sondee (ou passez `--url`).
- `openclaw gateway status` et `openclaw doctor` font remonter la **derniere erreur de la passerelle** depuis les logs lorsque le service semble en cours mais que le port est ferme.
- Les liaisons non loopback (`lan`/`tailnet`/`custom`, ou `auto` lorsque loopback est indisponible) necessitent une authentification :
  `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`).
- `gateway.remote.token` est reserve aux appels CLI distants ; il **n’active pas** l’authentification locale.
- `gateway.token` est ignore ; utilisez `gateway.auth.token`.

**Si `openclaw gateway status` montre une discordance de configuration**

- `Config (cli): ...` et `Config (service): ...` devraient normalement correspondre.
- Si ce n’est pas le cas, vous editez presque certainement une configuration pendant que le service en utilise une autre.
- Correction : relancez `openclaw gateway install --force` depuis le meme `--profile` / `OPENCLAW_STATE_DIR` que vous souhaitez que le service utilise.

**Si `openclaw gateway status` signale des problemes de configuration du service**

- La configuration du superviseur (launchd/systemd/schtasks) ne contient pas les valeurs par defaut actuelles.
- Correction : executez `openclaw doctor` pour la mettre a jour (ou `openclaw gateway install --force` pour une reecriture complete).

**Si `Last gateway error:` mentionne « refusing to bind … without auth »**

- Vous avez defini `gateway.bind` sur un mode non loopback (`lan`/`tailnet`/`custom`, ou `auto` lorsque loopback est indisponible) sans configurer l’authentification.
- Correction : definir `gateway.auth.mode` + `gateway.auth.token` (ou exporter `OPENCLAW_GATEWAY_TOKEN`) et redemarrer le service.

**Si `openclaw gateway status` indique `bind=tailnet` mais qu’aucune interface tailnet n’a ete trouvee**

- La passerelle a tente de se lier a une IP Tailscale (100.64.0.0/10) mais aucune n’a ete detectee sur l’hote.
- Correction : demarrez Tailscale sur cette machine (ou changez `gateway.bind` vers `loopback`/`lan`).

**Si `Probe note:` indique que la sonde utilise loopback**

- C’est attendu pour `bind=lan` : la passerelle ecoute sur `0.0.0.0` (toutes les interfaces), et loopback doit toujours se connecter localement.
- Pour les clients distants, utilisez une IP LAN reelle (pas `0.0.0.0`) plus le port, et assurez-vous que l’authentification est configuree.

### Adresse deja utilisee (Port 18789)

Cela signifie que quelque chose ecoute deja sur le port de la passerelle.

**Verifier :**

```bash
openclaw gateway status
```

Cela affichera les processus a l’ecoute et les causes probables (passerelle deja en cours, tunnel SSH).
Au besoin, arretez le service ou choisissez un autre port.

### Dossiers d’espace de travail supplementaires detectes

Si vous avez mis a niveau depuis d’anciennes installations, vous pouvez encore avoir `~/openclaw` sur le disque.
Plusieurs repertoires d’espace de travail peuvent provoquer une authentification confuse ou une derive d’etat, car
un seul espace de travail est actif.

**Correction :** conservez un seul espace de travail actif et archivez/supprimez le reste. Voir
[Agent workspace](/concepts/agent-workspace#extra-workspace-folders).

### Discussion principale executee dans un espace de travail sandbox

Symptomes : `pwd` ou les outils de fichiers affichent `~/.openclaw/sandboxes/...` alors que vous
attendiez l’espace de travail de l’hote.

**Pourquoi :** `agents.defaults.sandbox.mode: "non-main"` se base sur `session.mainKey` (par defaut `"main"`).
Les sessions de groupe/canal utilisent leurs propres cles, elles sont donc traitees comme non principales et
obtiennent des espaces de travail sandbox.

**Options de correction :**

- Si vous voulez des espaces de travail hote pour un agent : definir `agents.list[].sandbox.mode: "off"`.
- Si vous voulez l’acces a l’espace de travail hote a l’interieur du sandbox : definir `workspaceAccess: "rw"` pour cet agent.

### « Agent was aborted »

L’agent a ete interrompu en cours de reponse.

**Causes :**

- L’utilisateur a envoye `stop`, `abort`, `esc`, `wait` ou `exit`
- Delai depasse
- Le processus a plante

**Correction :** envoyez simplement un autre message. La session continue.

### « Agent failed before reply: Unknown model: anthropic/claude-haiku-3-5 »

OpenClaw rejette intentionnellement les **modeles anciens/non securises** (en particulier ceux plus
vulnerables a l’injection d’invites). Si vous voyez cette erreur, le nom du modele n’est plus pris en charge.

**Correction :**

- Choisissez un modele **recent** pour le fournisseur et mettez a jour votre configuration ou alias de modele.
- Si vous n’etes pas sur des modeles disponibles, executez `openclaw models list` ou
  `openclaw models scan` et choisissez-en un pris en charge.
- Consultez les logs de la passerelle pour la raison detaillee de l’echec.

Voir aussi : [Models CLI](/cli/models) et [Model providers](/concepts/model-providers).

### Les messages ne declenchent pas

**Verification 1 :** l’expediteur est-il sur la liste d’autorisation ?

```bash
openclaw status
```

Recherchez `AllowFrom: ...` dans la sortie.

**Verification 2 :** pour les discussions de groupe, la mention est-elle requise ?

```bash
# The message must match mentionPatterns or explicit mentions; defaults live in channel groups/guilds.
# Multi-agent: `agents.list[].groupChat.mentionPatterns` overrides global patterns.
grep -n "agents\\|groupChat\\|mentionPatterns\\|channels\\.whatsapp\\.groups\\|channels\\.telegram\\.groups\\|channels\\.imessage\\.groups\\|channels\\.discord\\.guilds" \
  "${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
```

**Verification 3 :** verifiez les logs

```bash
openclaw logs --follow
# or if you want quick filters:
tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)" | grep "blocked\\|skip\\|unauthorized"
```

### Le code d’appairage n’arrive pas

Si `dmPolicy` est `pairing`, les expediteurs inconnus doivent recevoir un code et leur message est ignore jusqu’a approbation.

**Verification 1 :** une demande en attente existe-t-elle deja ?

```bash
openclaw pairing list <channel>
```

Les demandes d’appairage DM en attente sont limitees a **3 par canal** par defaut. Si la liste est pleine, les nouvelles demandes ne genereront pas de code tant qu’une n’est pas approuvee ou expiree.

**Verification 2 :** la demande a-t-elle ete creee mais aucune reponse envoyee ?

```bash
openclaw logs --follow | grep "pairing request"
```

**Verification 3 :** confirmez que `dmPolicy` n’est pas `open`/`allowlist` pour ce canal.

### Image + mention ne fonctionne pas

Probleme connu : lorsque vous envoyez une image avec UNIQUEMENT une mention (sans autre texte), WhatsApp n’inclut parfois pas les metadonnees de mention.

**Contournement :** ajoutez du texte avec la mention :

- ❌ `@openclaw` + image
- ✅ `@openclaw check this` + image

### La session ne reprend pas

**Verification 1 :** le fichier de session est-il present ?

```bash
ls -la ~/.openclaw/agents/<agentId>/sessions/
```

**Verification 2 :** la fenetre de reinitialisation est-elle trop courte ?

```json
{
  "session": {
    "reset": {
      "mode": "daily",
      "atHour": 4,
      "idleMinutes": 10080 // 7 days
    }
  }
}
```

**Verification 3 :** quelqu’un a-t-il envoye `/new`, `/reset` ou un declencheur de reinitialisation ?

### Delai d’expiration de l’agent

Le delai par defaut est de 30 minutes. Pour les taches longues :

```json
{
  "reply": {
    "timeoutSeconds": 3600 // 1 hour
  }
}
```

Ou utilisez l’outil `process` pour executer des commandes longues en arriere-plan.

### WhatsApp deconnecte

```bash
# Check local status (creds, sessions, queued events)
openclaw status
# Probe the running gateway + channels (WA connect + Telegram + Discord APIs)
openclaw status --deep

# View recent connection events
openclaw logs --limit 200 | grep "connection\\|disconnect\\|logout"
```

**Correction :** se reconnecte generalement automatiquement une fois la Gateway (passerelle) en cours. Si vous etes bloque, redemarrez le processus de la Gateway (passerelle) (selon votre supervision), ou lancez-le manuellement avec une sortie verbeuse :

```bash
openclaw gateway --verbose
```

Si vous etes deconnecte / desassocie :

```bash
openclaw channels logout
trash "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/credentials" # if logout can't cleanly remove everything
openclaw channels login --verbose       # re-scan QR
```

### Echec de l’envoi de medias

**Verification 1 :** le chemin du fichier est-il valide ?

```bash
ls -la /path/to/your/image.jpg
```

**Verification 2 :** est-il trop volumineux ?

- Images : max 6 Mo
- Audio/Video : max 16 Mo
- Documents : max 100 Mo

**Verification 3 :** verifiez les logs medias

```bash
grep "media\\|fetch\\|download" "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)" | tail -20
```

### Utilisation memoire elevee

OpenClaw conserve l’historique des conversations en memoire.

**Correction :** redemarrez periodiquement ou definissez des limites de session :

```json
{
  "session": {
    "historyLimit": 100 // Max messages to keep
  }
}
```

## Depannage courant

### « Gateway ne demarre pas — configuration invalide »

OpenClaw refuse desormais de demarrer lorsque la configuration contient des cles inconnues, des valeurs mal formees ou des types invalides.
C’est intentionnel pour la securite.

Corrigez avec Doctor :

```bash
openclaw doctor
openclaw doctor --fix
```

Notes :

- `openclaw doctor` signale chaque entree invalide.
- `openclaw doctor --fix` applique des migrations/reparations et reecrit la configuration.
- Les commandes de diagnostic comme `openclaw logs`, `openclaw health`, `openclaw status`, `openclaw gateway status` et `openclaw gateway probe` s’executent toujours meme si la configuration est invalide.

### « Tous les modeles ont echoue » — que verifier en premier ?

- **Identifiants** presents pour le(s) fournisseur(s) testes (profils d’auth + variables d’environnement).
- **Routage des modeles** : confirmez que `agents.defaults.model.primary` et les replis sont des modeles auxquels vous avez acces.
- **Logs de la passerelle** dans `/tmp/openclaw/…` pour l’erreur exacte du fournisseur.
- **Etat du modele** : utilisez `/model status` (chat) ou `openclaw models status` (CLI).

### J’utilise mon numero WhatsApp personnel — pourquoi l’auto‑discussion est bizarre ?

Activez le mode auto‑discussion et ajoutez votre propre numero a la liste d’autorisation :

```json5
{
  channels: {
    whatsapp: {
      selfChatMode: true,
      dmPolicy: "allowlist",
      allowFrom: ["+15555550123"],
    },
  },
}
```

Voir [WhatsApp setup](/channels/whatsapp).

### WhatsApp m’a deconnecte. Comment me re‑authentifier ?

Relancez la commande de connexion et scannez le code QR :

```bash
openclaw channels login
```

### Erreurs de build sur `main` — quel est le chemin standard de correction ?

1. `git pull origin main && pnpm install`
2. `openclaw doctor`
3. Verifiez les issues GitHub ou Discord
4. Contournement temporaire : revenir a un commit plus ancien

### npm install echoue (allow-build-scripts / tar ou yargs manquant). Que faire ?

Si vous executez depuis les sources, utilisez le gestionnaire de paquets du repo : **pnpm** (prefere).
Le repo declare `packageManager: "pnpm@…"`.

Recuperation typique :

```bash
git status   # ensure you’re in the repo root
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

Pourquoi : pnpm est le gestionnaire de paquets configure pour ce repo.

### Comment basculer entre installations git et npm ?

Utilisez **l’installateur du site web** et selectionnez la methode d’installation avec un indicateur. Il
met a niveau sur place et reecrit le service de la passerelle pour pointer vers la nouvelle installation.

Basculer **vers l’installation git** :

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
```

Basculer **vers npm global** :

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Notes :

- Le flux git ne rebase que si le depot est propre. Validez ou stash les changements d’abord.
- Apres le basculement, executez :
  ```bash
  openclaw doctor
  openclaw gateway restart
  ```

### Le streaming par blocs Telegram ne separe pas le texte entre les appels d’outils. Pourquoi ?

Le streaming par blocs n’envoie que des **blocs de texte completes**. Raisons courantes pour lesquelles vous voyez un seul message :

- `agents.defaults.blockStreamingDefault` est encore `"off"`.
- `channels.telegram.blockStreaming` est defini sur `false`.
- `channels.telegram.streamMode` est `partial` ou `block` **et le streaming de brouillon est actif**
  (discussion privee + sujets). Le streaming de brouillon desactive le streaming par blocs dans ce cas.
- Vos parametres `minChars` / de coalescence sont trop eleves, donc les fragments sont fusionnes.
- Le modele emet un seul grand bloc de texte (pas de points de vidage en cours de reponse).

Liste de correction :

1. Placez les parametres de streaming par blocs sous `agents.defaults`, pas a la racine.
2. Definissez `channels.telegram.streamMode: "off"` si vous voulez de vraies reponses multi‑messages par blocs.
3. Utilisez des seuils de fragments/coalescence plus petits pendant le debogage.

Voir [Streaming](/concepts/streaming).

### Discord ne repond pas dans mon serveur meme avec `requireMention: false`. Pourquoi ?

`requireMention` controle uniquement le filtrage par mention **apres** que le canal a passe les listes d’autorisation.
Par defaut, `channels.discord.groupPolicy` est **allowlist**, donc les guildes doivent etre explicitement activees.
Si vous definissez `channels.discord.guilds.<guildId>.channels`, seuls les canaux listes sont autorises ; omettez-le pour autoriser tous les canaux de la guilde.

Liste de correction :

1. Definissez `channels.discord.groupPolicy: "open"` **ou** ajoutez une entree d’allowlist de guilde (et eventuellement une allowlist de canal).
2. Utilisez des **ID de canal numeriques** dans `channels.discord.guilds.<guildId>.channels`.
3. Placez `requireMention: false` **sous** `channels.discord.guilds` (global ou par canal).
   Le niveau superieur `channels.discord.requireMention` n’est pas une cle prise en charge.
4. Assurez-vous que le bot dispose de **Message Content Intent** et des permissions de canal.
5. Executez `openclaw channels status --probe` pour des indices d’audit.

Docs : [Discord](/channels/discord), [Channels troubleshooting](/channels/troubleshooting).

### Erreur API Cloud Code Assist : schema d’outil invalide (400). Que faire ?

C’est presque toujours un probleme de **compatibilite de schema d’outil**. L’endpoint Cloud Code Assist
accepte un sous‑ensemble strict de JSON Schema. OpenClaw nettoie/normalise les schemas d’outils dans les versions
actuelles de `main`, mais la correction n’est pas encore dans la derniere version (au
13 janvier 2026).

Liste de correction :

1. **Mettre a jour OpenClaw** :
   - Si vous pouvez executer depuis les sources, tirez `main` et redemarrez la passerelle.
   - Sinon, attendez la prochaine version incluant le nettoyeur de schema.
2. Evitez les mots‑cles non pris en charge comme `anyOf/oneOf/allOf`, `patternProperties`,
   `additionalProperties`, `minLength`, `maxLength`, `format`, etc.
3. Si vous definissez des outils personnalises, gardez le schema de niveau superieur comme `type: "object"` avec
   `properties` et des enums simples.

Voir [Tools](/tools) et [TypeBox schemas](/concepts/typebox).

## Problemes specifiques a macOS

### L’application plante lors de l’octroi des autorisations (Parole/Micro)

Si l’application disparait ou affiche « Abort trap 6 » lorsque vous cliquez sur « Autoriser » dans une invite de confidentialite :

**Correction 1 : Reinitialiser le cache TCC**

```bash
tccutil reset All bot.molt.mac.debug
```

**Correction 2 : Forcer un nouvel identifiant de bundle**
Si la reinitialisation ne fonctionne pas, modifiez le `BUNDLE_ID` dans [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) (par ex., ajoutez un suffixe `.test`) et reconstruisez. Cela force macOS a le traiter comme une nouvelle application.

### Gateway bloquee sur « Starting… »

L’application se connecte a une passerelle locale sur le port `18789`. Si elle reste bloquee :

**Correction 1 : Arreter le superviseur (prefere)**
Si la passerelle est supervisee par launchd, tuer le PID ne fera que la relancer. Arretez d’abord le superviseur :

```bash
openclaw gateway status
openclaw gateway stop
# Or: launchctl bootout gui/$UID/bot.molt.gateway (replace with bot.molt.<profile>; legacy com.openclaw.* still works)
```

**Correction 2 : Le port est occupe (trouver l’ecoute)**

```bash
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

S’il s’agit d’un processus non supervise, essayez d’abord un arret gracieux, puis escaladez :

```bash
kill -TERM <PID>
sleep 1
kill -9 <PID> # last resort
```

**Correction 3 : Verifier l’installation de la CLI**
Assurez-vous que la CLI globale `openclaw` est installee et correspond a la version de l’application :

```bash
openclaw --version
npm install -g openclaw@<version>
```

## Mode debug

Obtenez une journalisation verbeuse :

```bash
# Turn on trace logging in config:
#   ${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json} -> { logging: { level: "trace" } }
#
# Then run verbose commands to mirror debug output to stdout:
openclaw gateway --verbose
openclaw channels login --verbose
```

## Emplacements des logs

| Log                                            | Emplacement                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logs fichier de la passerelle (structures)     | `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (ou `logging.file`)                                                                                                                                                                                                                                                                                  |
| Logs du service de la passerelle (superviseur) | macOS : `$OPENCLAW_STATE_DIR/logs/gateway.log` + `gateway.err.log` (par defaut : `~/.openclaw/logs/...` ; les profils utilisent `~/.openclaw-<profile>/logs/...`)<br />Linux : `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`<br />Windows : `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST` |
| Fichiers de session                            | `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                                                                                                                                                                                                                                                                                             |
| Cache medias                                   | `$OPENCLAW_STATE_DIR/media/`                                                                                                                                                                                                                                                                                                                 |
| Identifiants                                   | `$OPENCLAW_STATE_DIR/credentials/`                                                                                                                                                                                                                                                                                                           |

## Verification de sante

```bash
# Supervisor + probe target + config paths
openclaw gateway status
# Include system-level scans (legacy/extra services, port listeners)
openclaw gateway status --deep

# Is the gateway reachable?
openclaw health --json
# If it fails, rerun with connection details:
openclaw health --verbose

# Is something listening on the default port?
lsof -nP -iTCP:18789 -sTCP:LISTEN

# Recent activity (RPC log tail)
openclaw logs --follow
# Fallback if RPC is down
tail -20 /tmp/openclaw/openclaw-*.log
```

## Reinitialiser completement

Option nucleaire :

```bash
openclaw gateway stop
# If you installed a service and want a clean install:
# openclaw gateway uninstall

trash "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
openclaw channels login         # re-pair WhatsApp
openclaw gateway restart           # or: openclaw gateway
```

⚠️ Cela supprime toutes les sessions et necessite un nouvel appairage WhatsApp.

## Obtenir de l’aide

1. Verifiez d’abord les logs : `/tmp/openclaw/` (par defaut : `openclaw-YYYY-MM-DD.log`, ou votre `logging.file` configure)
2. Recherchez les issues existantes sur GitHub
3. Ouvrez une nouvelle issue avec :
   - Version d’OpenClaw
   - Extraits de logs pertinents
   - Etapes pour reproduire
   - Votre configuration (masquez les secrets !)

---

_« Avez‑vous essaye de l’eteindre et de le rallumer ? »_ — Tous les informaticiens, un jour

🦞🔧

### Le navigateur ne demarre pas (Linux)

Si vous voyez `"Failed to start Chrome CDP on port 18800"` :

**Cause la plus probable :** Chromium installe via Snap sur Ubuntu.

**Correction rapide :** installez Google Chrome a la place :

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
```

Puis definissez dans la configuration :

```json
{
  "browser": {
    "executablePath": "/usr/bin/google-chrome-stable"
  }
}
```

**Guide complet :** voir [browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
