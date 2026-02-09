---
summary: "Statut de prise en charge de l’application Google Chat, capacites et configuration"
read_when:
  - Travail sur les fonctionnalites du canal Google Chat
title: "Google Chat"
---

# Google Chat (Chat API)

Statut : pret pour les Messages prives et les espaces via les webhooks de l’API Google Chat (HTTP uniquement).

## Demarrage rapide (debutant)

1. Creez un projet Google Cloud et activez la **Google Chat API**.
   - Allez sur : [Identifiants de l’API Google Chat](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - Activez l’API si ce n’est pas deja fait.
2. Creez un **Service Account** :
   - Cliquez sur **Create Credentials** > **Service Account**.
   - Donnez-lui le nom de votre choix (par ex., `openclaw-chat`).
   - Laissez les autorisations vides (cliquez sur **Continue**).
   - Laissez les principaux ayant acces vides (cliquez sur **Done**).
3. Creez et telechargez la **cle JSON** :
   - Dans la liste des comptes de service, cliquez sur celui que vous venez de creer.
   - Allez dans l’onglet **Keys**.
   - Cliquez sur **Add Key** > **Create new key**.
   - Selectionnez **JSON** et cliquez sur **Create**.
4. Stockez le fichier JSON telecharge sur l’hote de votre Gateway (passerelle) (par ex., `~/.openclaw/googlechat-service-account.json`).
5. Creez une application Google Chat dans la [Configuration Chat de la Google Cloud Console](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat) :
   - Renseignez les **Application info** :
     - **App name** : (par ex. `OpenClaw`)
     - **Avatar URL** : (par ex. `https://openclaw.ai/logo.png`)
     - **Description** : (par ex. `Personal AI Assistant`)
   - Activez **Interactive features**.
   - Dans **Functionality**, cochez **Join spaces and group conversations**.
   - Dans **Connection settings**, selectionnez **HTTP endpoint URL**.
   - Dans **Triggers**, selectionnez **Use a common HTTP endpoint URL for all triggers** et definissez-le sur l’URL publique de votre Gateway (passerelle) suivie de `/googlechat`.
     - _Astuce : Executez `openclaw status` pour trouver l’URL publique de votre Gateway (passerelle)._
   - Dans **Visibility**, cochez **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;**.
   - Saisissez votre adresse e-mail (par ex. `user@example.com`) dans le champ de texte.
   - Cliquez sur **Save** en bas de page.
6. **Activez le statut de l’application** :
   - Apres l’enregistrement, **actualisez la page**.
   - Recherchez la section **App status** (generalement pres du haut ou du bas apres l’enregistrement).
   - Changez le statut en **Live - available to users**.
   - Cliquez de nouveau sur **Save**.
7. Configurez OpenClaw avec le chemin du compte de service + l’audience du webhook :
   - Env : `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - Ou config : `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. Definissez le type et la valeur de l’audience du webhook (correspond a la configuration de votre application Chat).
9. Demarrez la Gateway (passerelle). Google Chat enverra des POST vers le chemin de votre webhook.

## Ajouter a Google Chat

Une fois la Gateway (passerelle) demarree et votre e-mail ajoute a la liste de visibilite :

1. Allez sur [Google Chat](https://chat.google.com/).
2. Cliquez sur l’icone **+** (plus) a cote de **Direct Messages**.
3. Dans la barre de recherche (la ou vous ajoutez habituellement des personnes), saisissez le **App name** que vous avez configure dans la Google Cloud Console.
   - **Remarque** : Le bot n’apparaitra _pas_ dans la liste de navigation « Marketplace » car il s’agit d’une application privee. Vous devez le rechercher par son nom.
4. Selectionnez votre bot dans les resultats.
5. Cliquez sur **Add** ou **Chat** pour demarrer une conversation 1:1.
6. Envoyez « Hello » pour declencher l’assistant !

## URL publique (webhook uniquement)

Les webhooks Google Chat necessitent un point de terminaison HTTPS public. Pour des raisons de securite, **n’exposez que le chemin `/googlechat`** a Internet. Conservez le tableau de bord OpenClaw et les autres points de terminaison sensibles sur votre reseau prive.

### Option A : Tailscale Funnel (recommande)

Utilisez Tailscale Serve pour le tableau de bord prive et Funnel pour le chemin du webhook public. Cela permet de garder `/` prive tout en n’exposant que `/googlechat`.

1. **Verifiez a quelle adresse votre Gateway (passerelle) est liee :**

   ```bash
   ss -tlnp | grep 18789
   ```

   Notez l’adresse IP (par ex., `127.0.0.1`, `0.0.0.0`, ou votre IP Tailscale comme `100.x.x.x`).

2. **Exposez le tableau de bord uniquement au tailnet (port 8443) :**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **Exposez uniquement le chemin du webhook publiquement :**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **Autorisez le nœud pour l’acces Funnel :**
   Si vous y etes invite, visitez l’URL d’autorisation affichee dans la sortie pour activer Funnel pour ce nœud dans la politique de votre tailnet.

5. **Verifiez la configuration :**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

Votre URL publique de webhook sera :
`https://<node-name>.<tailnet>.ts.net/googlechat`

Votre tableau de bord prive reste reserve au tailnet :
`https://<node-name>.<tailnet>.ts.net:8443/`

Utilisez l’URL publique (sans `:8443`) dans la configuration de l’application Google Chat.

> Remarque : Cette configuration persiste apres les redemarrages. Pour la supprimer ulterieurement, executez `tailscale funnel reset` et `tailscale serve reset`.

### Option B : Proxy inverse (Caddy)

Si vous utilisez un proxy inverse comme Caddy, ne proxyfiez que le chemin specifique :

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

Avec cette configuration, toute requete vers `your-domain.com/` sera ignoree ou retournera une 404, tandis que `your-domain.com/googlechat` est achemine en toute securite vers OpenClaw.

### Option C : Tunnel Cloudflare

Configurez les regles d’entree de votre tunnel pour n’acheminer que le chemin du webhook :

- **Path** : `/googlechat` -> `http://localhost:18789/googlechat`
- **Default Rule** : HTTP 404 (Not Found)

## Fonctionnement

1. Google Chat envoie des POST de webhook a la Gateway (passerelle). Chaque requete inclut un en-tete `Authorization: Bearer <token>`.
2. OpenClaw verifie le jeton par rapport aux `audienceType` + `audience` configures :
   - `audienceType: "app-url"` → l’audience est l’URL HTTPS de votre webhook.
   - `audienceType: "project-number"` → l’audience est le numero du projet Cloud.
3. Les messages sont routes par espace :
   - Les Messages prives utilisent la cle de session `agent:<agentId>:googlechat:dm:<spaceId>`.
   - Les espaces utilisent la cle de session `agent:<agentId>:googlechat:group:<spaceId>`.
4. L’acces aux Messages prives est appariement par defaut. Les expediteurs inconnus recoivent un code d’appariement ; approuvez avec :
   - `openclaw pairing approve googlechat <code>`
5. Les espaces de groupe necessitent par defaut une @-mention. Utilisez `botUser` si la detection de mention doit utiliser le nom d’utilisateur de l’application.

## Cibles

Utilisez ces identifiants pour la livraison et les listes d’autorisation :

- Messages prives : `users/<userId>` ou `users/<email>` (les adresses e-mail sont acceptees).
- Espaces : `spaces/<spaceId>`.

## Points forts de configuration

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; helps mention detection
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890", "name@example.com"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": {
          allow: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Short answers only.",
        },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

Remarques :

- Les informations d’identification du compte de service peuvent aussi etre transmises en ligne avec `serviceAccount` (chaine JSON).
- Le chemin de webhook par defaut est `/googlechat` si `webhookPath` n’est pas defini.
- Les reactions sont disponibles via l’outil `reactions` et `channels action` lorsque `actions.reactions` est active.
- `typingIndicator` prend en charge `none`, `message` (par defaut) et `reaction` (la reaction necessite l’OAuth utilisateur).
- Les pieces jointes sont telechargees via l’API Chat et stockees dans le pipeline media (taille plafonnee par `mediaMaxMb`).

## Problemes courants

### 405 Method Not Allowed

Si Google Cloud Logs Explorer affiche des erreurs telles que :

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

Cela signifie que le gestionnaire de webhook n’est pas enregistre. Causes courantes :

1. **Canal non configure** : La section `channels.googlechat` est absente de votre configuration. Verifiez avec :

   ```bash
   openclaw config get channels.googlechat
   ```

   Si cela renvoie « Config path not found », ajoutez la configuration (voir [Points forts de configuration](#points-forts-de-configuration)).

2. **Plugin non active** : Verifiez l’etat du plugin :

   ```bash
   openclaw plugins list | grep googlechat
   ```

   S’il affiche « disabled », ajoutez `plugins.entries.googlechat.enabled: true` a votre configuration.

3. **Gateway (passerelle) non redemarree** : Apres l’ajout de la configuration, redemarrez la Gateway (passerelle) :

   ```bash
   openclaw gateway restart
   ```

Verifiez que le canal est en cours d’execution :

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### Autres problemes

- Verifiez `openclaw channels status --probe` pour les erreurs d’authentification ou une configuration d’audience manquante.
- Si aucun message n’arrive, confirmez l’URL de webhook de l’application Chat + les abonnements aux evenements.
- Si le filtrage par mention bloque les reponses, definissez `botUser` sur le nom de ressource utilisateur de l’application et verifiez `requireMention`.
- Utilisez `openclaw logs --follow` lors de l’envoi d’un message de test pour voir si les requetes atteignent la Gateway (passerelle).

Documents connexes :

- [Configuration de la Gateway (passerelle)](/gateway/configuration)
- [Securite](/gateway/security)
- [Reactions](/tools/reactions)
