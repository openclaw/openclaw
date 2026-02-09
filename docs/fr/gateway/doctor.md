---
summary: "Commande Doctor : controles de sante, migrations de configuration et etapes de reparation"
read_when:
  - Ajout ou modification des migrations de Doctor
  - Introduction de changements de configuration incompatibles
title: "Doctor"
---

# Doctor

`openclaw doctor` est l’outil de reparation + migration pour OpenClaw. Il corrige les
configurations/etats obsoletes, verifie la sante et fournit des etapes de reparation actionnables.

## Demarrage rapide

```bash
openclaw doctor
```

### Sans interface / automatisation

```bash
openclaw doctor --yes
```

Accepter les valeurs par defaut sans invite (y compris les etapes de reparation de redemarrage/service/sandbox lorsque applicable).

```bash
openclaw doctor --repair
```

Appliquer les reparations recommandees sans invite (reparations + redemarrages lorsque c’est sans risque).

```bash
openclaw doctor --repair --force
```

Appliquer egalement les reparations agressives (ecrase les configurations personnalisees du superviseur).

```bash
openclaw doctor --non-interactive
```

Executer sans invites et n’appliquer que les migrations sures (normalisation de la configuration + deplacements d’etat sur disque). Ignore les actions de redemarrage/service/sandbox qui necessitent une confirmation humaine.
Les migrations d’etat herite s’executent automatiquement lorsqu’elles sont detectees.

```bash
openclaw doctor --deep
```

Analyser les services systeme pour detecter des installations supplementaires de gateway (launchd/systemd/schtasks).

Si vous souhaitez examiner les changements avant ecriture, ouvrez d’abord le fichier de configuration :

```bash
cat ~/.openclaw/openclaw.json
```

## Ce que cela fait (resume)

- Mise a jour pre-vol optionnelle pour les installations git (interactif uniquement).
- Verification de la fraicheur du protocole UI (reconstruit l’UI de controle lorsque le schema de protocole est plus recent).
- Controle de sante + invite de redemarrage.
- Resume de l’etat des Skills (eligibles/manquants/bloques).
- Normalisation de la configuration pour les valeurs heritees.
- Avertissements de substitution du fournisseur OpenCode Zen (`models.providers.opencode`).
- Migration de l’etat herite sur disque (sessions/repertoire agent/auth WhatsApp).
- Verifications d’integrite et de permissions de l’etat (sessions, transcriptions, repertoire d’etat).
- Verifications des permissions du fichier de configuration (chmod 600) lors d’une execution locale.
- Sante de l’authentification des modeles : verifie l’expiration OAuth, peut rafraichir les jetons proches de l’expiration et signale les etats de refroidissement/desactivation des profils d’authentification.
- Detection de repertoires d’espace de travail supplementaires (`~/openclaw`).
- Reparation de l’image sandbox lorsque le sandboxing est active.
- Migration des services herites et detection de gateways supplementaires.
- Verifications d’execution de la Gateway (service installe mais non demarre ; etiquette launchd en cache).
- Avertissements d’etat des canaux (sondes depuis la gateway en cours d’execution).
- Audit de la configuration du superviseur (launchd/systemd/schtasks) avec reparation optionnelle.
- Verifications des bonnes pratiques d’execution de la Gateway (Node vs Bun, chemins des gestionnaires de versions).
- Diagnostics de collision de port de la Gateway (par defaut `18789`).
- Avertissements de securite pour les politiques de Messages prives ouvertes.
- Avertissements d’authentification de la Gateway lorsqu’aucun `gateway.auth.token` n’est defini (mode local ; propose la generation d’un jeton).
- Verification de systemd linger sous Linux.
- Verifications d’installation depuis les sources (decalage d’espace de travail pnpm, ressources UI manquantes, binaire tsx manquant).
- Ecrit la configuration mise a jour + les metadonnees de l’assistant.

## Comportement detaille et justification

### 0. Mise a jour optionnelle (installations git)

S’il s’agit d’un depot git et que Doctor s’execute en mode interactif, il propose de
mettre a jour (fetch/rebase/build) avant d’executer Doctor.

### 1. Normalisation de la configuration

Si la configuration contient des formes de valeurs heritees (par exemple `messages.ackReaction`
sans substitution specifique au canal), Doctor les normalise vers le schema actuel.

### 2. Migrations des cles de configuration heritees

Lorsque la configuration contient des cles obsoletes, les autres commandes refusent de s’executer et vous demandent
d’executer `openclaw doctor`.

Doctor va :

- Expliquer quelles clés anciennes ont été trouvées.
- Afficher la migration appliquee.
- Reecrire `~/.openclaw/openclaw.json` avec le schema mis a jour.

La Gateway execute egalement automatiquement les migrations Doctor au demarrage lorsqu’elle detecte
un format de configuration herite, afin que les configurations obsoletes soient reparees sans intervention manuelle.

Migrations actuelles :

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → niveau superieur `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) Substitutions du fournisseur OpenCode Zen

Si vous avez ajoute `models.providers.opencode` (ou `opencode-zen`) manuellement, cela
remplace le catalogue OpenCode Zen integre depuis `@mariozechner/pi-ai`. Cela peut
forcer tous les modeles sur une seule API ou annuler les couts. Doctor avertit afin que vous puissiez
supprimer la substitution et restaurer le routage API et les couts par modele.

### 3. Migrations d’etat herite (structure disque)

Doctor peut migrer d’anciennes structures sur disque vers la structure actuelle :

- Stockage des sessions + transcriptions :
  - de `~/.openclaw/sessions/` vers `~/.openclaw/agents/<agentId>/sessions/`
- Repertoire agent :
  - de `~/.openclaw/agent/` vers `~/.openclaw/agents/<agentId>/agent/`
- Etat d’authentification WhatsApp (Baileys) :
  - depuis l’heritage `~/.openclaw/credentials/*.json` (sauf `oauth.json`)
  - vers `~/.openclaw/credentials/whatsapp/<accountId>/...` (identifiant de compte par defaut : `default`)

Ces migrations sont « best-effort » et idempotentes ; Doctor emet des avertissements
lorsqu’il laisse des dossiers herites en sauvegarde. La Gateway/CLI migre egalement
automatiquement les sessions heritees + le repertoire agent au demarrage afin que l’historique/l’authentification/les modeles
arrivent dans le chemin par agent sans execution manuelle de Doctor. L’authentification WhatsApp
est volontairement migree uniquement via `openclaw doctor`.

### 4. Verifications d’integrite de l’etat (persistance des sessions, routage et securite)

Le repertoire d’etat est le tronc cerebral operationnel. S’il disparait, vous perdez
les sessions, les identifiants, les journaux et la configuration (sauf si vous avez des sauvegardes ailleurs).

Doctor verifie :

- **Repertoire d’etat manquant** : avertit d’une perte d’etat catastrophique, propose de recreer
  le repertoire et rappelle qu’il ne peut pas recuperer des donnees manquantes.
- **Permissions du repertoire d’etat** : verifie l’ecriture ; propose de reparer les permissions
  (et emet un indice `chown` lorsqu’une discordance proprietaire/groupe est detectee).
- **Repertoires de sessions manquants** : `sessions/` et le repertoire de stockage des sessions sont
  requis pour persister l’historique et eviter des plantages `ENOENT`.
- **Incoherence des transcriptions** : avertit lorsque des entrees de session recentes ont des
  fichiers de transcription manquants.
- **Session principale « JSONL a une ligne »** : signale lorsque la transcription principale n’a qu’une
  seule ligne (l’historique ne s’accumule pas).
- **Plusieurs repertoires d’etat** : avertit lorsque plusieurs dossiers `~/.openclaw` existent a travers
  les repertoires personnels ou lorsque `OPENCLAW_STATE_DIR` pointe ailleurs (l’historique peut
  se repartir entre des installations).
- **Rappel du mode distant** : si `gateway.mode=remote`, Doctor rappelle de l’executer
  sur l’hote distant (l’etat s’y trouve).
- **Permissions du fichier de configuration** : avertit si `~/.openclaw/openclaw.json` est
  lisible par le groupe/le monde et propose de resserrer a `600`.

### 5. Sante de l’authentification des modeles (expiration OAuth)

Doctor inspecte les profils OAuth dans le magasin d’authentification, avertit lorsque les jetons
expirent/sont expires et peut les rafraichir lorsque c’est sans risque. Si le profil Anthropic Claude Code
est obsolete, il suggere d’executer `claude setup-token` (ou de coller un setup-token).
Les invites de rafraichissement n’apparaissent qu’en mode interactif (TTY) ; `--non-interactive`
ignore les tentatives de rafraichissement.

Doctor signale egalement les profils d’authentification temporairement inutilisables en raison de :

- courts delais de refroidissement (limites de debit/delais/erreurs d’authentification)
- desactivations plus longues (facturation/echec de credit)

### 6. Validation du modele Hooks

Si `hooks.gmail.model` est defini, Doctor valide la reference du modele par rapport au
catalogue et a la liste d’autorisation et avertit lorsqu’elle ne se resout pas ou est interdite.

### 7. Reparation de l’image sandbox

Lorsque le sandboxing est active, Doctor verifie les images Docker et propose de construire ou
de basculer vers des noms herites si l’image actuelle est manquante.

### 8. Migrations des services de Gateway et indications de nettoyage

Doctor detecte les services de gateway herites (launchd/systemd/schtasks) et
propose de les supprimer et d’installer le service OpenClaw en utilisant le port de gateway actuel. Il peut egalement analyser la presence de services de type gateway supplementaires et afficher des indications de nettoyage.
Les services de gateway OpenClaw nommes par profil sont consideres de premiere classe et ne sont pas
signales comme « supplementaires ».

### 9. Avertissements de securite

Doctor emet des avertissements lorsqu’un fournisseur est ouvert aux Messages prives sans liste d’autorisation,
ou lorsqu’une politique est configuree de maniere dangereuse.

### 10. systemd linger (Linux)

S’il s’execute en tant que service utilisateur systemd, Doctor s’assure que le linger est active afin que la
gateway reste active apres la deconnexion.

### 11. Etat des Skills

Doctor affiche un resume rapide des Skills eligibles/manquants/bloques pour l’espace de travail actuel.

### 12. Verifications d’authentification de la Gateway (jeton local)

Doctor avertit lorsque `gateway.auth` est manquant sur une gateway locale et propose de
generer un jeton. Utilisez `openclaw doctor --generate-gateway-token` pour forcer la creation du jeton
en automatisation.

### 13. Controle de sante de la Gateway + redemarrage

Doctor effectue un controle de sante et propose de redemarrer la gateway lorsqu’elle semble
malsaine.

### 14. Avertissements d’etat des canaux

Si la gateway est saine, Doctor execute une sonde d’etat des canaux et signale
les avertissements avec des corrections suggerees.

### 15. Audit + reparation de la configuration du superviseur

Doctor verifie la configuration du superviseur installee (launchd/systemd/schtasks) pour
des valeurs par defaut manquantes ou obsoletes (par ex., dependances systemd network-online et
delai de redemarrage). Lorsqu’il trouve une discordance, il recommande une mise a jour et peut
reecrire le fichier de service/la tache vers les valeurs par defaut actuelles.

Notes :

- `openclaw doctor` demande confirmation avant de reecrire la configuration du superviseur.
- `openclaw doctor --yes` accepte les invites de reparation par defaut.
- `openclaw doctor --repair` applique les corrections recommandees sans invites.
- `openclaw doctor --repair --force` ecrase les configurations personnalisees du superviseur.
- Vous pouvez toujours forcer une reecriture complete via `openclaw gateway install --force`.

### 16. Diagnostics d’execution de la Gateway + port

Doctor inspecte l’execution du service (PID, dernier etat de sortie) et avertit lorsque le
service est installe mais n’est pas reellement en cours d’execution. Il verifie egalement les collisions
de port sur le port de la gateway (par defaut `18789`) et signale les causes probables (gateway deja
en cours d’execution, tunnel SSH).

### 17. Bonnes pratiques d’execution de la Gateway

Doctor avertit lorsque le service de la gateway s’execute sur Bun ou un chemin Node gere par un gestionnaire
de versions (`nvm`, `fnm`, `volta`, `asdf`, etc.). Les canaux WhatsApp + Telegram
necessitent Node, et les chemins des gestionnaires de versions peuvent se rompre apres des mises a niveau car le
service ne charge pas l’initialisation de votre shell. Doctor propose de migrer vers une installation Node systeme
lorsqu’elle est disponible (Homebrew/apt/choco).

### 18. Ecriture de la configuration + metadonnees de l’assistant

Doctor persiste toutes les modifications de configuration et appose des metadonnees d’assistant pour
enregistrer l’execution de Doctor.

### 19. Conseils d’espace de travail (sauvegarde + systeme de memoire)

Doctor suggere un systeme de memoire d’espace de travail lorsqu’il est absent et affiche un conseil de sauvegarde
si l’espace de travail n’est pas deja sous git.

Voir [/concepts/agent-workspace](/concepts/agent-workspace) pour un guide complet de la structure de l’espace de travail
et de la sauvegarde git (recommandee via GitHub ou GitLab prives).
