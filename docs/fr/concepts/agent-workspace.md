---
summary: "Espace de travail de l’agent : emplacement, organisation et strategie de sauvegarde"
read_when:
  - Vous devez expliquer l’espace de travail de l’agent ou son organisation de fichiers
  - Vous souhaitez sauvegarder ou migrer un espace de travail d’agent
title: "Espace de travail de l’agent"
---

# Espace de travail de l’agent

L’espace de travail est le foyer de l’agent. C’est le seul repertoire de travail utilise pour
les outils de fichiers et pour le contexte de l’espace de travail. Gardez‑le prive et
traitez‑le comme une memoire.

Il est distinct de `~/.openclaw/`, qui stocke la configuration, les identifiants et
les sessions.

**Important :** l’espace de travail est le **cwd par defaut**, pas un sandbox rigide. Les outils
resolvent les chemins relatifs par rapport a l’espace de travail, mais les chemins absolus
peuvent toujours acceder a d’autres emplacements sur l’hote sauf si le sandboxing est
active. Si vous avez besoin d’isolation, utilisez
[`agents.defaults.sandbox`](/gateway/sandboxing) (et/ou une configuration de sandbox par agent).
Lorsque le sandboxing est active et que `workspaceAccess` n’est pas `"rw"`, les outils
fonctionnent a l’interieur d’un espace de travail en sandbox sous `~/.openclaw/sandboxes`, et non
dans votre espace de travail hote.

## Emplacement par défaut

- Par defaut : `~/.openclaw/workspace`
- Si `OPENCLAW_PROFILE` est defini et n’est pas `"default"`, la valeur par defaut devient
  `~/.openclaw/workspace-<profile>`.
- Surcharge dans `~/.openclaw/openclaw.json` :

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`, `openclaw configure` ou `openclaw setup` creeront l’espace de travail et amorceront
les fichiers de bootstrap s’ils sont manquants.

Si vous gerez deja vous‑meme les fichiers de l’espace de travail, vous pouvez desactiver
la creation des fichiers de bootstrap :

```json5
{ agent: { skipBootstrap: true } }
```

## Dossiers d’espace de travail supplementaires

Les installations plus anciennes peuvent avoir cree `~/openclaw`. Conserver plusieurs
repertoires d’espace de travail peut provoquer une derive d’authentification ou d’etat
deroutante, car un seul espace de travail est actif a la fois.

**Recommandation :** conservez un seul espace de travail actif. Si vous n’utilisez plus les
dossiers supplementaires, archivez‑les ou deplacez‑les a la Corbeille (par exemple
`trash ~/openclaw`).
Si vous conservez intentionnellement plusieurs espaces de travail,
assurez‑vous que `agents.defaults.workspace` pointe vers celui qui est actif.

`openclaw doctor` avertit lorsqu’il detecte des repertoires d’espace de travail supplementaires.

## Carte des fichiers de l’espace de travail (signification de chaque fichier)

Voici les fichiers standard qu’OpenClaw attend dans l’espace de travail :

- `AGENTS.md`
  - Instructions de fonctionnement pour l’agent et la facon dont il doit utiliser la memoire.
  - Charge au debut de chaque session.
  - Bon endroit pour les regles, les priorites et les details de « comportement ».

- `SOUL.md`
  - Persona, ton et limites.
  - Charge a chaque session.

- `USER.md`
  - Qui est l’utilisateur et comment s’adresser a lui.
  - Charge a chaque session.

- `IDENTITY.md`
  - Nom, ambiance et emoji de l’agent.
  - Cree/mis a jour pendant le rituel de bootstrap.

- `TOOLS.md`
  - Notes sur vos outils locaux et conventions.
  - Ne controle pas la disponibilite des outils ; il s’agit uniquement d’indications.

- `HEARTBEAT.md`
  - Liste de controle optionnelle et concise pour les executions de heartbeat.
  - Gardez‑la courte pour eviter la consommation excessive de tokens.

- `BOOT.md`
  - Liste de controle de demarrage optionnelle executee au redemarrage de la Gateway (passerelle) lorsque les hooks internes sont actives.
  - Gardez‑la courte ; utilisez l’outil de message pour les envois sortants.

- `BOOTSTRAP.md`
  - Rituel unique de premiere execution.
  - Cree uniquement pour un espace de travail tout neuf.
  - Supprimez‑le une fois le rituel termine.

- `memory/YYYY-MM-DD.md`
  - Journal de memoire quotidien (un fichier par jour).
  - Recommande de lire aujourd’hui + hier au demarrage de la session.

- `MEMORY.md` (optionnel)
  - Memoire a long terme organisee.
  - A charger uniquement dans la session principale et privee (pas dans les contextes partages/de groupe).

Voir [Memory](/concepts/memory) pour le flux de travail et la purge automatique de la memoire.

- `skills/` (optionnel)
  - Skills specifiques a l’espace de travail.
  - Ecrasent les skills geres/regroupes en cas de collision de noms.

- `canvas/` (optionnel)
  - Fichiers d’interface Canvas pour les affichages de nœuds (par exemple `canvas/index.html`).

Si un fichier de bootstrap est manquant, OpenClaw injecte un marqueur « missing file » dans
la session et continue. Les gros fichiers de bootstrap sont tronques lors de l’injection ;
ajustez la limite avec `agents.defaults.bootstrapMaxChars` (par defaut : 20000).
`openclaw setup` peut recreer les valeurs par defaut manquantes sans ecraser les fichiers
existants.

## Ce qui N’EST PAS dans l’espace de travail

Ces elements se trouvent sous `~/.openclaw/` et ne doivent PAS etre commits dans le depot
de l’espace de travail :

- `~/.openclaw/openclaw.json` (configuration)
- `~/.openclaw/credentials/` (jetons OAuth, cles API)
- `~/.openclaw/agents/<agentId>/sessions/` (transcriptions de session + metadonnees)
- `~/.openclaw/skills/` (skills geres)

Si vous devez migrer des sessions ou la configuration, copiez‑les separement et conservez‑les
hors du controle de version.

## Sauvegarde Git (recommandee, privee)

Traitez l’espace de travail comme une memoire privee. Placez‑le dans un depot git **prive**
afin qu’il soit sauvegarde et recuperable.

Executez ces etapes sur la machine ou s’execute la Gateway (passerelle) (c’est la que se trouve
l’espace de travail).

### 1. Initialiser le depot

Si git est installe, les espaces de travail tout neufs sont initialises automatiquement. Si
cet espace de travail n’est pas deja un depot, executez :

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2. Ajouter un remote prive (options conviviales pour debutants)

Option A : interface web GitHub

1. Creez un nouveau depot **prive** sur GitHub.
2. Ne l’initialisez pas avec un README (evite les conflits de fusion).
3. Copiez l’URL HTTPS du remote.
4. Ajoutez le remote et poussez :

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

Option B : GitHub CLI (`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

Option C : interface web GitLab

1. Creez un nouveau depot **prive** sur GitLab.
2. Ne l’initialisez pas avec un README (evite les conflits de fusion).
3. Copiez l’URL HTTPS du remote.
4. Ajoutez le remote et poussez :

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3. Mises a jour continues

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## Ne commitez pas de secrets

Meme dans un depot prive, evitez de stocker des secrets dans l’espace de travail :

- Cles API, jetons OAuth, mots de passe ou identifiants prives.
- Tout ce qui se trouve sous `~/.openclaw/`.
- Des dumps bruts de conversations ou des pieces jointes sensibles.

Si vous devez stocker des references sensibles, utilisez des espaces reservés et conservez
le secret reel ailleurs (gestionnaire de mots de passe, variables d’environnement ou
`~/.openclaw/`).

Modele de demarrage `.gitignore` suggere :

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## Deplacer l’espace de travail vers une nouvelle machine

1. Clonez le depot vers le chemin souhaite (par defaut `~/.openclaw/workspace`).
2. Definissez `agents.defaults.workspace` sur ce chemin dans `~/.openclaw/openclaw.json`.
3. Executez `openclaw setup --workspace <path>` pour amorcer les fichiers manquants.
4. Si vous avez besoin des sessions, copiez `~/.openclaw/agents/<agentId>/sessions/` depuis l’ancienne machine
   separement.

## Notes avancees

- Le routage multi‑agents peut utiliser des espaces de travail differents par agent. Voir
  [Channel routing](/concepts/channel-routing) pour la configuration du routage.
- Si `agents.defaults.sandbox` est active, les sessions non principales peuvent utiliser des espaces de
  travail en sandbox par session sous `agents.defaults.sandbox.workspaceRoot`.
