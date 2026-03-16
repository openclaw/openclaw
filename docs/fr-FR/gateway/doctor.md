---
summary: "Commande Doctor : vérifications de santé, migrations de configuration et étapes de réparation"
read_when:
  - Ajout ou modification de migrations doctor
  - Introduction de changements de configuration majeurs
title: "Doctor"
---

# Doctor

`openclaw doctor` est l'outil de réparation + migration pour OpenClaw. Il corrige la
configuration/état obsolète, vérifie la santé et fournit des étapes de réparation actionnables.

## Démarrage rapide

```bash
openclaw doctor
```

### Sans interface / automatisation

```bash
openclaw doctor --yes
```

Accepter les valeurs par défaut sans demande (incluant les étapes de redémarrage/service/sandbox quand applicable).

```bash
openclaw doctor --repair
```

Appliquer les réparations recommandées sans demande (réparations + redémarrages quand sûr).

```bash
openclaw doctor --repair --force
```

Appliquer aussi les réparations agressives (écrase les configurations de superviseur personnalisées).

```bash
openclaw doctor --non-interactive
```

Exécuter sans demandes et appliquer uniquement les migrations sûres (normalisation de configuration + déplacements d'état sur disque). Saute les actions de redémarrage/service/sandbox qui nécessitent une confirmation humaine.
Les migrations d'état legacy s'exécutent automatiquement quand détectées.

```bash
openclaw doctor --deep
```

Scanner les services système pour les installations de passerelle supplémentaires (launchd/systemd/schtasks).

Si vous voulez revoir les changements avant écriture, ouvrez d'abord le fichier de configuration :

```bash
cat ~/.openclaw/openclaw.json
```

## Ce qu'il fait (résumé)

- Mise à jour pré-vol optionnelle pour les installations git (interactif uniquement).
- Vérification de fraîcheur du protocole UI (reconstruit l'UI de contrôle quand le schéma de protocole est plus récent).
- Vérification de santé + demande de redémarrage.
- Résumé du statut des compétences (éligibles/manquantes/bloquées).
- Normalisation de configuration pour les valeurs legacy.
- Avertissements d'override du fournisseur OpenCode Zen (`models.providers.opencode`).
- Migration d'état legacy sur disque (sessions/répertoire agent/auth WhatsApp).
- Vérifications d'intégrité et de permissions d'état (sessions, transcriptions, répertoire d'état).
- Vérifications de permissions du fichier de configuration (chmod 600) lors de l'exécution locale.
- Santé d'authentification des modèles : vérifie l'expiration OAuth, peut rafraîchir les jetons expirants et signale les états cooldown/désactivés du profil d'authentification.
- Détection de répertoire d'espace de travail supplémentaire (`~/openclaw`).
- Réparation d'image sandbox quand le sandboxing est activé.
- Migration de service legacy et détection de passerelle supplémentaire.
- Vérifications d'exécution de la passerelle (service installé mais pas en cours ; label launchd caché).
- Avertissements de statut des canaux (sondés depuis la passerelle en cours).
- Audit de configuration de superviseur (launchd/systemd/schtasks) avec réparation optionnelle.
- Vérifications de bonnes pratiques d'exécution de la passerelle (Node vs Bun, chemins de gestionnaire de version).
- Diagnostics de collision de port de passerelle (par défaut `18789`).
- Avertissements de sécurité pour les politiques DM ouvertes.
- Avertissements d'authentification de passerelle quand aucun `gateway.auth.token` n'est défini (mode local ; offre génération de jeton).
- Vérification linger systemd sur Linux.
- Vérifications d'installation source (incompatibilité d'espace de travail pnpm, assets UI manquants, binaire tsx manquant).
- Écrit la configuration mise à jour + métadonnées de wizard.

## Comportement détaillé et justification

### 0) Mise à jour optionnelle (installations git)

Si c'est un checkout git et que doctor s'exécute en mode interactif, il offre de
mettre à jour (fetch/rebase/build) avant d'exécuter doctor.

### 1) Normalisation de configuration

Si la configuration contient des formes de valeur legacy (par exemple `messages.ackReaction`
sans override spécifique au canal), doctor les normalise dans le schéma actuel.

### 2) Migrations de clés de configuration legacy

Quand la configuration contient des clés dépréciées, les autres commandes refusent de s'exécuter et demandent
d'exécuter `openclaw doctor`.

Doctor va :

- Expliquer quelles clés legacy ont été trouvées.
- Montrer la migration qu'il a appliquée.
- Réécrire `~/.openclaw/openclaw.json` avec le schéma mis à jour.

La passerelle exécute aussi automatiquement les migrations doctor au démarrage quand elle détecte un
format de configuration legacy, donc les configurations obsolètes sont réparées sans intervention manuelle.

Migrations actuelles :

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → `bindings` de niveau supérieur
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) Overrides du fournisseur OpenCode Zen

Si vous avez ajouté `models.providers.opencode` (ou `opencode-zen`) manuellement, il
écrase le catalogue OpenCode Zen intégré de `@mariozechner/pi-ai`. Cela peut
forcer chaque modèle sur une seule API ou mettre les coûts à zéro. Doctor avertit pour que vous puissiez
supprimer l'override et restaurer le routage API par modèle + les coûts.

### 3) Migrations d'état legacy (disposition sur disque)

Doctor peut migrer les anciennes dispositions sur disque dans la structure actuelle :

- Stockage de sessions + transcriptions :
  - de `~/.openclaw/sessions/` à `~/.openclaw/agents/<agentId>/sessions/`
- Répertoire agent :
  - de `~/.openclaw/agent/` à `~/.openclaw/agents/<agentId>/agent/`
- État d'authentification WhatsApp (Baileys) :
  - de legacy `~/.openclaw/credentials/*.json` (sauf `oauth.json`)
  - à `~/.openclaw/credentials/whatsapp/<accountId>/...` (id de compte par défaut : `default`)

Ces migrations sont au mieux et idempotentes ; doctor émettra des avertissements quand
il laisse des dossiers legacy derrière comme sauvegardes. La passerelle/CLI migre aussi automatiquement
les sessions legacy + répertoire agent au démarrage donc l'historique/auth/modèles atterrissent dans le
chemin par agent sans exécution manuelle de doctor. L'authentification WhatsApp n'est intentionnellement
migrée que via `openclaw doctor`.

### 4) Vérifications d'intégrité d'état (persistance de session, routage et sécurité)

Le répertoire d'état est le tronc cérébral opérationnel. S'il disparaît, vous perdez
les sessions, identifiants, journaux et configuration (à moins d'avoir des sauvegardes ailleurs).

Doctor vérifie :

- **Répertoire d'état manquant** : avertit de la perte d'état catastrophique, demande de recréer
  le répertoire et rappelle qu'il ne peut pas récupérer les données manquantes.
- **Permissions du répertoire d'état** : vérifie l'écriture ; offre de réparer les permissions
  (et émet un hint `chown` quand une incompatibilité propriétaire/groupe est détectée).
- **Répertoires de session manquants** : `sessions/` et le répertoire de stockage de session sont
  requis pour persister l'historique et éviter les crashs `ENOENT`.
- **Incompatibilité de transcription** : avertit quand les entrées de session récentes ont des
  fichiers de transcription manquants.
- **Session principale "1 ligne JSONL"** : signale quand la transcription principale n'a qu'une seule
  ligne (l'historique ne s'accumule pas).
- **Multiples répertoires d'état** : avertit quand plusieurs dossiers `~/.openclaw` existent à travers
  les répertoires home ou quand `OPENCLAW_STATE_DIR` pointe ailleurs (l'historique peut
  se diviser entre les installations).
- **Rappel mode distant** : si `gateway.mode=remote`, doctor vous rappelle de l'exécuter
  sur l'hôte distant (l'état vit là-bas).
- **Permissions du fichier de configuration** : avertit si `~/.openclaw/openclaw.json` est
  lisible par groupe/monde et offre de resserrer à `600`.

### 5) Santé d'authentification des modèles (expiration OAuth)

Doctor inspecte les profils OAuth dans le stockage d'authentification, avertit quand les jetons expirent/sont
expirés et peut les rafraîchir quand sûr. Si le profil Anthropic Claude Code
est obsolète, il suggère d'exécuter `claude setup-token` (ou de coller un setup-token).
Les demandes de rafraîchissement n'apparaissent que lors de l'exécution interactive (TTY) ; `--non-interactive`
saute les tentatives de rafraîchissement.

Doctor signale aussi les profils d'authentification temporairement inutilisables en raison de :

- cooldowns courts (limites de taux/timeouts/échecs d'auth)
- désactivations plus longues (échecs de facturation/crédit)

### 6) Validation du modèle de hooks

Si `hooks.gmail.model` est défini, doctor valide la référence de modèle contre le
catalogue et la liste blanche et avertit quand il ne se résoudra pas ou est interdit.

### 7) Réparation d'image sandbox

Quand le sandboxing est activé, doctor vérifie les images Docker et offre de construire ou
basculer vers des noms legacy si l'image actuelle est manquante.

### 8) Migrations de service de passerelle et hints de nettoyage

Doctor détecte les services de passerelle legacy (launchd/systemd/schtasks) et
offre de les supprimer et d'installer le service OpenClaw en utilisant le port de passerelle actuel.
Il peut aussi scanner pour des services de type passerelle supplémentaires et imprimer des hints de nettoyage.
Les services de passerelle OpenClaw nommés par profil sont considérés de première classe et ne sont pas
signalés comme "extra".

### 9) Avertissements de sécurité

Doctor émet des avertissements quand un fournisseur est ouvert aux DM sans liste blanche, ou
quand une politique est configurée de manière dangereuse.

### 10) systemd linger (Linux)

Si exécuté comme service utilisateur systemd, doctor s'assure que le lingering est activé pour que la
passerelle reste en vie après la déconnexion.

### 11) Statut des compétences

Doctor imprime un résumé rapide des compétences éligibles/manquantes/bloquées pour l'espace de
travail actuel.

### 12) Vérifications d'authentification de passerelle (jeton local)

Doctor avertit quand `gateway.auth` est manquant sur une passerelle locale et offre de
générer un jeton. Utilisez `openclaw doctor --generate-gateway-token` pour forcer la
création de jeton en automatisation.

### 13) Vérification de santé de passerelle + redémarrage

Doctor exécute une vérification de santé et offre de redémarrer la passerelle quand elle semble
malsaine.

### 14) Avertissements de statut des canaux

Si la passerelle est saine, doctor exécute une sonde de statut de canal et signale
les avertissements avec des corrections suggérées.

### 15) Audit de configuration de superviseur + réparation

Doctor vérifie la configuration de superviseur installée (launchd/systemd/schtasks) pour
les valeurs par défaut manquantes ou obsolètes (ex : dépendances network-online systemd et
délai de redémarrage). Quand il trouve une incompatibilité, il recommande une mise à jour et peut
réécrire le fichier de service/tâche aux valeurs par défaut actuelles.

Notes :

- `openclaw doctor` demande avant de réécrire la configuration de superviseur.
- `openclaw doctor --yes` accepte les demandes de réparation par défaut.
- `openclaw doctor --repair` applique les corrections recommandées sans demandes.
- `openclaw doctor --repair --force` écrase les configurations de superviseur personnalisées.
- Vous pouvez toujours forcer une réécriture complète via `openclaw gateway install --force`.

### 16) Exécution de passerelle + diagnostics de port

Doctor inspecte l'exécution du service (PID, dernier statut de sortie) et avertit quand le
service est installé mais pas réellement en cours. Il vérifie aussi les collisions de port
sur le port de passerelle (par défaut `18789`) et signale les causes probables (passerelle déjà
en cours, tunnel SSH).

### 17) Bonnes pratiques d'exécution de passerelle

Doctor avertit quand le service de passerelle s'exécute sur Bun ou un chemin Node géré par version
(`nvm`, `fnm`, `volta`, `asdf`, etc.). Les canaux WhatsApp + Telegram nécessitent Node,
et les chemins de gestionnaire de version peuvent casser après les mises à niveau car le service ne
charge pas votre init shell. Doctor offre de migrer vers une installation Node système quand
disponible (Homebrew/apt/choco).

### 18) Écriture de configuration + métadonnées de wizard

Doctor persiste tous les changements de configuration et estampille les métadonnées de wizard pour enregistrer
l'exécution de doctor.

### 19) Conseils d'espace de travail (sauvegarde + système de mémoire)

Doctor suggère un système de mémoire d'espace de travail quand manquant et imprime un conseil de sauvegarde
si l'espace de travail n'est pas déjà sous git.

Voir [/concepts/agent-workspace](/fr-FR/concepts/agent-workspace) pour un guide complet de
la structure d'espace de travail et de la sauvegarde git (GitHub privé ou GitLab recommandé).
