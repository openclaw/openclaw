---
summary: "Interface de controle basee sur le navigateur pour la Gateway (chat, nœuds, configuration)"
read_when:
  - Vous souhaitez exploiter la Gateway depuis un navigateur
  - Vous souhaitez un acces Tailnet sans tunnels SSH
title: "Interface de controle"
---

# Interface de controle (navigateur)

L’Interface de controle est une petite application monopage **Vite + Lit** servie par la Gateway (passerelle) :

- par defaut : `http://<host>:18789/`
- prefixe optionnel : definir `gateway.controlUi.basePath` (par ex. `/openclaw`)

Elle communique **directement avec le WebSocket de la Gateway** sur le meme port.

## Ouverture rapide (local)

Si la Gateway s’execute sur le meme ordinateur, ouvrez :

- http://127.0.0.1:18789/ (ou http://localhost:18789/)

Si la page ne se charge pas, demarrez d’abord la Gateway : `openclaw gateway`.

L’authentification est fournie lors de la negotiation WebSocket via :

- `connect.params.auth.token`
- `connect.params.auth.password`
  Le panneau des parametres du tableau de bord vous permet d’enregistrer un jeton ; les mots de passe ne sont pas persistés.
  L’assistant de prise en main genere un jeton de gateway par defaut ; collez‑le ici lors de la premiere connexion.

## Appairage d’appareil (premiere connexion)

Lorsque vous vous connectez a l’Interface de controle depuis un nouveau navigateur ou appareil, la Gateway
exige une **approbation d’appairage unique** — meme si vous etes sur le meme Tailnet
avec `gateway.auth.allowTailscale: true`. Il s’agit d’une mesure de securite pour prevenir
les acces non autorises.

**Ce que vous verrez :** « disconnected (1008): pairing required »

**Pour approuver l’appareil :**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

Une fois approuve, l’appareil est memorise et ne necessitera pas de re‑approbation sauf
si vous la revoquez avec `openclaw devices revoke --device <id> --role <role>`. Voir
[Devices CLI](/cli/devices) pour la rotation et la revocation des jetons.

**Notes :**

- Les connexions locales (`127.0.0.1`) sont approuvees automatiquement.
- Les connexions distantes (LAN, Tailnet, etc.) necessitent une approbation explicite.
- Chaque profil de navigateur genere un identifiant d’appareil unique ; changer de navigateur ou
  effacer les donnees du navigateur requerra un nouvel appairage.

## Ce qu’elle peut faire (aujourd’hui)

- Discuter avec le modele via la Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Diffuser les appels d’outils + cartes de sortie d’outils en direct dans le chat (evenements d’agent)
- Canaux : statut + connexion QR + configuration par canal pour WhatsApp/Telegram/Discord/Slack + canaux de plugins (Mattermost, etc.) (`channels.status`, `web.login.*`, `config.patch`)
- Instances : liste de presence + actualisation (`system-presence`)
- Sessions : liste + surcharges de pensee/verbeux par session (`sessions.list`, `sessions.patch`)
- Taches cron : lister/ajouter/executer/activer/desactiver + historique d’execution (`cron.*`)
- Skills : statut, activer/desactiver, installer, mises a jour de cles API (`skills.*`)
- Nœuds : liste + capacites (`node.list`)
- Approbations d’exec : modifier les listes d’autorisation de la gateway ou des nœuds + demander la politique pour `exec host=gateway/node` (`exec.approvals.*`)
- Configuration : afficher/modifier `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- Configuration : appliquer + redemarrer avec validation (`config.apply`) et reveiller la derniere session active
- Les ecritures de configuration incluent une protection par hachage de base pour eviter l’ecrasement de modifications concurrentes
- Schema de configuration + rendu de formulaires (`config.schema`, y compris les schemas de plugins + canaux) ; l’editeur JSON brut reste disponible
- Debogage : instantanes d’etat/sante/modeles + journal d’evenements + appels RPC manuels (`status`, `health`, `models.list`)
- Journaux : suivi en temps reel des journaux de fichiers de la gateway avec filtrage/export (`logs.tail`)
- Mise a jour : executer une mise a jour package/git + redemarrer (`update.run`) avec un rapport de redemarrage

Notes du panneau des taches cron :

- Pour les taches isolees, la livraison est par defaut une annonce de resume. Vous pouvez passer a « aucune » si vous souhaitez des executions internes uniquement.
- Les champs canal/cible apparaissent lorsque « annonce » est selectionne.

## Comportement du chat

- `chat.send` est **non bloquant** : il accuse reception immediatement avec `{ runId, status: "started" }` et la reponse est diffusee via des evenements `chat`.
- Un nouvel envoi avec le meme `idempotencyKey` renvoie `{ status: "in_flight" }` pendant l’execution, et `{ status: "ok" }` apres l’achevement.
- `chat.inject` ajoute une note de l’assistant a la transcription de la session et diffuse un evenement `chat` pour des mises a jour UI uniquement (pas d’execution d’agent, pas de livraison vers un canal).
- Arret :
  - Cliquez sur **Stop** (appelle `chat.abort`)
  - Tapez `/stop` (ou `stop|esc|abort|wait|exit|interrupt`) pour interrompre hors bande
  - `chat.abort` prend en charge `{ sessionKey }` (sans `runId`) pour interrompre toutes les executions actives de cette session

## Acces Tailnet (recommande)

### Tailscale Serve integre (prefere)

Conservez la Gateway sur la boucle locale et laissez Tailscale Serve la proxyfier en HTTPS :

```bash
openclaw gateway --tailscale serve
```

Ouvrez :

- `https://<magicdns>/` (ou votre `gateway.controlUi.basePath` configure)

Par defaut, les requetes Serve peuvent s’authentifier via les en‑tetes d’identite Tailscale
(`tailscale-user-login`) lorsque `gateway.auth.allowTailscale` est `true`. OpenClaw
verifie l’identite en resolvant l’adresse `x-forwarded-for` avec
`tailscale whois` et en la faisant correspondre a l’en‑tete, et n’accepte ces requetes que lorsque
la requete atteint la boucle locale avec les en‑tetes `x-forwarded-*` de Tailscale. Definissez
`gateway.auth.allowTailscale: false` (ou forcez `gateway.auth.mode: "password"`)
si vous souhaitez exiger un jeton/mot de passe meme pour le trafic Serve.

### Lier au tailnet + jeton

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Puis ouvrez :

- `http://<tailscale-ip>:18789/` (ou votre `gateway.controlUi.basePath` configure)

Collez le jeton dans les parametres de l’UI (envoye comme `connect.params.auth.token`).

## HTTP non securise

Si vous ouvrez le tableau de bord via HTTP simple (`http://<lan-ip>` ou `http://<tailscale-ip>`),
le navigateur s’execute dans un **contexte non securise** et bloque WebCrypto. Par defaut,
OpenClaw **bloque** les connexions de l’Interface de controle sans identite d’appareil.

**Correctif recommande :** utilisez HTTPS (Tailscale Serve) ou ouvrez l’UI localement :

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (sur l’hote de la gateway)

**Exemple de retrogradation (jeton uniquement via HTTP) :**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

Cela desactive l’identite d’appareil + l’appairage pour l’Interface de controle (meme en HTTPS). A n’utiliser
que si vous faites confiance au reseau.

Voir [Tailscale](/gateway/tailscale) pour des conseils de configuration HTTPS.

## Construction de l’UI

La Gateway sert des fichiers statiques depuis `dist/control-ui`. Construisez‑les avec :

```bash
pnpm ui:build # auto-installs UI deps on first run
```

Base absolue optionnelle (lorsque vous souhaitez des URL d’actifs fixes) :

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

Pour le developpement local (serveur de dev separe) :

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

Puis pointez l’UI vers l’URL WS de votre Gateway (par ex. `ws://127.0.0.1:18789`).

## Debogage/tests : serveur de dev + Gateway distante

L’Interface de controle est composee de fichiers statiques ; la cible WebSocket est configurable et peut etre
differente de l’origine HTTP. C’est pratique lorsque vous souhaitez le serveur de dev Vite en local
mais que la Gateway s’execute ailleurs.

1. Demarrez le serveur de dev de l’UI : `pnpm ui:dev`
2. Ouvrez une URL comme :

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

Authentification ponctuelle optionnelle (si necessaire) :

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

Notes :

- `gatewayUrl` est stocke dans localStorage apres le chargement et retire de l’URL.
- `token` est stocke dans localStorage ; `password` est conserve uniquement en memoire.
- Lorsque `gatewayUrl` est defini, l’UI ne retombe pas sur la configuration ni sur les identifiants d’environnement.
  Fournissez explicitement `token` (ou `password`). L’absence d’identifiants explicites est une erreur.
- Utilisez `wss://` lorsque la Gateway est derriere TLS (Tailscale Serve, proxy HTTPS, etc.).
- `gatewayUrl` n’est accepte que dans une fenetre de premier niveau (non integree) afin d’empecher le clickjacking.
- Pour les configurations de dev multi‑origines (par ex. `pnpm ui:dev` vers une Gateway distante), ajoutez l’origine
  de l’UI a `gateway.controlUi.allowedOrigins`.

Exemple :

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Details de configuration de l’acces distant : [Acces distant](/gateway/remote).
