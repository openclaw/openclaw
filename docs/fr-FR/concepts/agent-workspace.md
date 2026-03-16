---
summary: "Espace de travail de l'agent : emplacement, disposition et stratégie de sauvegarde"
read_when:
  - Vous devez expliquer l'espace de travail de l'agent ou sa disposition de fichier
  - Vous voulez sauvegarder ou migrer un espace de travail d'agent
title: "Espace de travail de l'agent"
---

# Espace de travail de l'agent

L'espace de travail est le foyer de l'agent. C'est le seul répertoire de travail utilisé pour
les outils de fichier et le contexte d'espace de travail. Gardez-le privé et traitez-le comme de la mémoire.

Ceci est séparé de `~/.openclaw/`, qui stocke la config, les identifiants et les
sessions.

**Important :** l'espace de travail est le **cwd par défaut**, pas un sandbox dur. Les outils
résolvent les chemins relatifs contre l'espace de travail, mais les chemins absolus peuvent toujours atteindre
ailleurs sur l'hôte sauf si le sandboxing est activé. Si vous avez besoin d'isolation, utilisez
[`agents.defaults.sandbox`](/fr-FR/gateway/sandboxing) (et/ou config de sandbox par agent).
Quand le sandboxing est activé et que `workspaceAccess` n'est pas `"rw"`, les outils opèrent
à l'intérieur d'un espace de travail en sandbox sous `~/.openclaw/sandboxes`, pas votre espace de travail hôte.

## Emplacement par défaut

- Par défaut : `~/.openclaw/workspace`
- Si `OPENCLAW_PROFILE` est défini et n'est pas `"default"`, le défaut devient
  `~/.openclaw/workspace-<profile>`.
- Remplacer dans `~/.openclaw/openclaw.json` :

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`, `openclaw configure` ou `openclaw setup` créeront l'espace de travail et ensemenceront les fichiers d'amorçage s'ils sont manquants.

Si vous gérez déjà vous-même les fichiers d'espace de travail, vous pouvez désactiver la création de fichiers d'amorçage :

```json5
{ agent: { skipBootstrap: true } }
```

## Dossiers d'espace de travail supplémentaires

Les anciennes installations peuvent avoir créé `~/openclaw`. Garder plusieurs répertoires d'espace de travail
peut causer une dérive d'authentification ou d'état confuse, car un seul espace de travail est actif à la fois.

**Recommandation :** gardez un seul espace de travail actif. Si vous n'utilisez plus les
dossiers supplémentaires, archivez-les ou déplacez-les vers la Corbeille (par exemple `trash ~/openclaw`).
Si vous gardez intentionnellement plusieurs espaces de travail, assurez-vous que
`agents.defaults.workspace` pointe vers l'actif.

`openclaw doctor` avertit quand il détecte des répertoires d'espace de travail supplémentaires.

## Carte des fichiers d'espace de travail (ce que signifie chaque fichier)

Voici les fichiers standards qu'OpenClaw attend dans l'espace de travail :

- `AGENTS.md`
  - Instructions d'exploitation pour l'agent et comment il devrait utiliser la mémoire.
  - Chargé au démarrage de chaque session.
  - Bon endroit pour les règles, priorités et détails "comment se comporter".

- `SOUL.md`
  - Personnalité, ton et limites.
  - Chargé à chaque session.

- `USER.md`
  - Qui est l'utilisateur et comment s'adresser à lui.
  - Chargé à chaque session.

- `IDENTITY.md`
  - Le nom, l'ambiance et l'emoji de l'agent.
  - Créé/mis à jour pendant le rituel d'amorçage.

- `TOOLS.md`
  - Notes sur vos outils locaux et conventions.
  - Ne contrôle pas la disponibilité des outils ; c'est seulement un guide.

- `HEARTBEAT.md`
  - Liste de contrôle minuscule optionnelle pour les exécutions heartbeat.
  - Gardez-la courte pour éviter la brûlure de jetons.

- `BOOT.md`
  - Liste de contrôle de démarrage optionnelle exécutée au redémarrage de la passerelle quand les accroches internes sont activées.
  - Gardez-la courte ; utilisez l'outil de message pour les envois sortants.

- `BOOTSTRAP.md`
  - Rituel unique de première exécution.
  - Créé uniquement pour un tout nouvel espace de travail.
  - Supprimez-le après que le rituel soit complet.

- `memory/YYYY-MM-DD.md`
  - Journal de mémoire quotidien (un fichier par jour).
  - Recommandé de lire aujourd'hui + hier au démarrage de session.

- `MEMORY.md` (optionnel)
  - Mémoire à long terme curée.
  - Charger uniquement dans la session principale, privée (pas les contextes partagés/groupe).

Voir [Mémoire](/fr-FR/concepts/memory) pour le flux de travail et le vidage automatique de mémoire.

- `skills/` (optionnel)
  - Compétences spécifiques à l'espace de travail.
  - Remplace les compétences gérées/intégrées quand les noms entrent en collision.

- `canvas/` (optionnel)
  - Fichiers d'interface Canvas pour les affichages de nœud (par exemple `canvas/index.html`).

Si un fichier d'amorçage est manquant, OpenClaw injecte un marqueur "fichier manquant" dans
la session et continue. Les gros fichiers d'amorçage sont tronqués lors de l'injection ;
ajustez la limite avec `agents.defaults.bootstrapMaxChars` (par défaut : 20000).
`openclaw setup` peut recréer les valeurs par défaut manquantes sans écraser les fichiers
existants.

## Ce qui n'est PAS dans l'espace de travail

Ceux-ci vivent sous `~/.openclaw/` et ne devraient PAS être commitées dans le dépôt d'espace de travail :

- `~/.openclaw/openclaw.json` (config)
- `~/.openclaw/credentials/` (jetons OAuth, clés API)
- `~/.openclaw/agents/<agentId>/sessions/` (transcriptions de session + métadonnées)
- `~/.openclaw/skills/` (compétences gérées)

Si vous devez migrer des sessions ou une config, copiez-les séparément et gardez-les
hors du contrôle de version.

## Sauvegarde Git (recommandée, privée)

Traitez l'espace de travail comme une mémoire privée. Mettez-le dans un dépôt git **privé** pour qu'il soit
sauvegardé et récupérable.

Exécutez ces étapes sur la machine où la Passerelle s'exécute (c'est là que l'espace de travail vit).

### 1) Initialiser le dépôt

Si git est installé, les nouveaux espaces de travail sont initialisés automatiquement. Si cet
espace de travail n'est pas déjà un dépôt, exécutez :

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2) Ajouter un distant privé (options conviviales pour débutants)

Option A : Interface web GitHub

1. Créez un nouveau dépôt **privé** sur GitHub.
2. N'initialisez pas avec un README (évite les conflits de fusion).
3. Copiez l'URL distante HTTPS.
4. Ajoutez le distant et poussez :

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

Option B : CLI GitHub (`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

Option C : Interface web GitLab

1. Créez un nouveau dépôt **privé** sur GitLab.
2. N'initialisez pas avec un README (évite les conflits de fusion).
3. Copiez l'URL distante HTTPS.
4. Ajoutez le distant et poussez :

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3) Mises à jour continues

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## Ne commitez pas de secrets

Même dans un dépôt privé, évitez de stocker des secrets dans l'espace de travail :

- Clés API, jetons OAuth, mots de passe ou identifiants privés.
- Quoi que ce soit sous `~/.openclaw/`.
- Vidages bruts de chats ou pièces jointes sensibles.

Si vous devez stocker des références sensibles, utilisez des espaces réservés et gardez le vrai
secret ailleurs (gestionnaire de mots de passe, variables d'environnement, ou `~/.openclaw/`).

Démarrage `.gitignore` suggéré :

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## Déplacer l'espace de travail vers une nouvelle machine

1. Clonez le dépôt vers le chemin désiré (par défaut `~/.openclaw/workspace`).
2. Définissez `agents.defaults.workspace` vers ce chemin dans `~/.openclaw/openclaw.json`.
3. Exécutez `openclaw setup --workspace <path>` pour ensemencer tous fichiers manquants.
4. Si vous avez besoin de sessions, copiez `~/.openclaw/agents/<agentId>/sessions/` depuis l'ancienne machine séparément.

## Notes avancées

- Le routage multi-agents peut utiliser différents espaces de travail par agent. Voir
  [Routage de canal](/fr-FR/channels/channel-routing) pour la configuration de routage.
- Si `agents.defaults.sandbox` est activé, les sessions non-main peuvent utiliser des espaces de travail en sandbox
  par session sous `agents.defaults.sandbox.workspaceRoot`.
