---
summary: "Support app Google Chat, capacités et configuration"
read_when:
  - Travail sur fonctionnalités canal Google Chat
title: "Google Chat"
---

# Google Chat (Chat API)

Statut : prêt pour DM + espaces via webhooks API Google Chat (HTTP uniquement).

## Configuration rapide (débutant)

1. Créez un projet Google Cloud et activez l'**API Google Chat**.
   - Allez sur : [Identifiants API Google Chat](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - Activez l'API si elle n'est pas déjà activée.
2. Créez un **Compte de service** :
   - Appuyez sur **Créer identifiants** > **Compte de service**.
   - Nommez-le comme vous voulez (par ex., `openclaw-chat`).
   - Laissez les permissions vides (appuyez sur **Continuer**).
   - Laissez les principaux avec accès vides (appuyez sur **Terminé**).
3. Créez et téléchargez la **Clé JSON** :
   - Dans la liste des comptes de service, cliquez sur celui que vous venez de créer.
   - Allez dans l'onglet **Clés**.
   - Cliquez sur **Ajouter une clé** > **Créer nouvelle clé**.
   - Sélectionnez **JSON** et appuyez sur **Créer**.
4. Stockez le fichier JSON téléchargé sur votre hôte passerelle (par ex., `~/.openclaw/googlechat-service-account.json`).
5. Créez une app Google Chat dans la [Configuration Chat Console Google Cloud](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat) :
   - Remplissez les **Infos application** :
     - **Nom d'app** : (par ex. `OpenClaw`)
     - **URL Avatar** : (par ex. `https://openclaw.ai/logo.png`)
     - **Description** : (par ex. `Assistant IA Personnel`)
   - Activez **Fonctionnalités interactives**.
   - Sous **Fonctionnalité**, cochez **Rejoindre espaces et conversations de groupe**.
   - Sous **Paramètres de connexion**, sélectionnez **URL de point de terminaison HTTP**.
   - Sous **Déclencheurs**, sélectionnez **Utiliser URL de point de terminaison HTTP commune pour tous déclencheurs** et définissez-la sur l'URL publique de votre passerelle suivie de `/googlechat`.
     - _Astuce : Exécutez `openclaw status` pour trouver l'URL publique de votre passerelle._
   - Sous **Visibilité**, cochez **Rendre cette app Chat disponible à personnes et groupes spécifiques dans &lt;Votre Domaine&gt;**.
   - Entrez votre adresse email (par ex. `user@example.com`) dans la zone de texte.
   - Cliquez sur **Enregistrer** en bas.
6. **Activez le statut de l'app** :
   - Après sauvegarde, **rafraîchissez la page**.
   - Cherchez la section **Statut de l'app** (généralement près du haut ou en bas après sauvegarde).
   - Changez le statut en **Live - disponible aux utilisateurs**.
   - Cliquez à nouveau sur **Enregistrer**.
7. Configurez OpenClaw avec le chemin du compte de service + audience webhook :
   - Env : `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/chemin/vers/service-account.json`
   - Ou config : `channels.googlechat.serviceAccountFile: "/chemin/vers/service-account.json"`.
8. Définissez le type d'audience webhook + valeur (correspond à votre config app Chat).
9. Démarrez la passerelle. Google Chat fera POST vers votre chemin webhook.

## Ajouter à Google Chat

Une fois la passerelle en cours d'exécution et votre email ajouté à la liste de visibilité :

1. Allez sur [Google Chat](https://chat.google.com/).
2. Cliquez sur l'icône **+** (plus) à côté de **Messages directs**.
3. Dans la barre de recherche (où vous ajoutez habituellement des personnes), tapez le **Nom d'app** que vous avez configuré dans la Console Google Cloud.
   - **Note** : Le bot n'apparaîtra _pas_ dans la liste de navigation "Marketplace" car c'est une app privée. Vous devez le rechercher par nom.
4. Sélectionnez votre bot depuis les résultats.
5. Cliquez sur **Ajouter** ou **Chat** pour démarrer une conversation 1:1.
6. Envoyez "Bonjour" pour déclencher l'assistant !

## URL publique (Webhook uniquement)

Les webhooks Google Chat nécessitent un point de terminaison HTTPS public. Pour la sécurité, **exposez uniquement le chemin `/googlechat`** à Internet. Gardez le tableau de bord OpenClaw et autres points de terminaison sensibles sur votre réseau privé.

### Option A : Tailscale Funnel (Recommandé)

Utilisez Tailscale Serve pour le tableau de bord privé et Funnel pour le chemin webhook public. Cela garde `/` privé tout en exposant uniquement `/googlechat`.

[Instructions détaillées disponibles dans le fichier original...]

## Fonctionnement

1. Google Chat envoie des webhooks POST à la passerelle. Chaque requête inclut un header `Authorization: Bearer <token>`.
2. OpenClaw vérifie le jeton contre le `audienceType` + `audience` configuré :
   - `audienceType: "app-url"` → audience est votre URL webhook HTTPS.
   - `audienceType: "project-number"` → audience est le numéro de projet Cloud.
3. Les messages sont routés par espace :
   - Les DM utilisent la clé de session `agent:<agentId>:googlechat:dm:<spaceId>`.
   - Les espaces utilisent la clé de session `agent:<agentId>:googlechat:group:<spaceId>`.

## Voir aussi

- [Configuration de la Passerelle](/fr-FR/gateway/configuration)
- [Sécurité](/fr-FR/gateway/security)
- [Réactions](/fr-FR/tools/reactions)
