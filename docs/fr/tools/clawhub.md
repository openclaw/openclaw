---
summary: "Guide ClawHub : registre public de Skills + flux de travail CLI"
read_when:
  - Presentation de ClawHub aux nouveaux utilisateurs
  - Installation, recherche ou publication de Skills
  - Explication des options CLI ClawHub et du comportement de synchronisation
title: "ClawHub"
---

# ClawHub

ClawHub est le **registre public de Skills pour OpenClaw**. C’est un service gratuit : tous les Skills sont publics, ouverts et visibles par tous pour le partage et la reutilisation. Un Skill est simplement un dossier avec un fichier `SKILL.md` (plus des fichiers texte de support). Vous pouvez parcourir les Skills dans l’application web ou utiliser la CLI pour rechercher, installer, mettre a jour et publier des Skills.

Site : [clawhub.ai](https://clawhub.ai)

## Ce qu’est ClawHub

- Un registre public pour les Skills OpenClaw.
- Un stockage versionne de bundles de Skills et de metadonnees.
- Une surface de decouverte pour la recherche, les tags et les signaux d’utilisation.

## Comment cela fonctionne

1. Un utilisateur publie un bundle de Skill (fichiers + metadonnees).
2. ClawHub stocke le bundle, analyse les metadonnees et attribue une version.
3. Le registre indexe le Skill pour la recherche et la decouverte.
4. Les utilisateurs parcourent, telechargent et installent des Skills dans OpenClaw.

## Ce que vous pouvez faire

- Publier de nouveaux Skills et de nouvelles versions de Skills existants.
- Decouvrir des Skills par nom, tags ou recherche.
- Telecharger des bundles de Skills et inspecter leurs fichiers.
- Signaler des Skills abusifs ou dangereux.
- Si vous etes moderateur, masquer, demasquer, supprimer ou bannir.

## A qui cela s’adresse (adapté aux debutants)

Si vous souhaitez ajouter de nouvelles capacites a votre agent OpenClaw, ClawHub est le moyen le plus simple de trouver et d’installer des Skills. Vous n’avez pas besoin de savoir comment fonctionne le backend. Vous pouvez :

- Rechercher des Skills en langage naturel.
- Installer un Skill dans votre espace de travail.
- Mettre a jour les Skills plus tard avec une seule commande.
- Sauvegarder vos propres Skills en les publiant.

## Demarrage rapide (non technique)

1. Installez la CLI (voir la section suivante).
2. Recherchez ce dont vous avez besoin :
   - `clawhub search "calendar"`
3. Installez un Skill :
   - `clawhub install <skill-slug>`
4. Demarrez une nouvelle session OpenClaw afin qu’elle prenne en compte le nouveau Skill.

## Installer la CLI

Choisissez l’une des options :

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## Comment cela s’integre dans OpenClaw

Par defaut, la CLI installe les Skills dans `./skills` sous votre repertoire de travail actuel. Si un espace de travail OpenClaw est configure, `clawhub` bascule vers cet espace de travail sauf si vous remplacez `--workdir` (ou `CLAWHUB_WORKDIR`). OpenClaw charge les Skills de l’espace de travail depuis `<workspace>/skills` et les prendra en compte lors de la **prochaine** session. Si vous utilisez deja `~/.openclaw/skills` ou des Skills integres, les Skills de l’espace de travail ont la priorite.

Pour plus de details sur la facon dont les Skills sont charges, partages et controles, consultez
[Skills](/tools/skills).

## Vue d’ensemble du systeme de Skills

Un Skill est un bundle versionne de fichiers qui apprend a OpenClaw comment effectuer une tache specifique. Chaque publication cree une nouvelle version, et le registre conserve un historique des versions afin que les utilisateurs puissent auditer les changements.

Un Skill typique comprend :

- Un fichier `SKILL.md` avec la description principale et l’utilisation.
- Des configurations, scripts ou fichiers de support optionnels utilises par le Skill.
- Des metadonnees telles que les tags, le resume et les exigences d’installation.

ClawHub utilise les metadonnees pour alimenter la decouverte et exposer en toute securite les capacites des Skills.
Le registre suit egalement des signaux d’utilisation (tels que les etoiles et les telechargements) afin d’ameliorer le classement et la visibilite.

## Ce que le service fournit (fonctionnalites)

- **Navigation publique** des Skills et de leur contenu `SKILL.md`.
- **Recherche** alimentee par des embeddings (recherche vectorielle), et pas seulement par mots-cles.
- **Versionnage** avec semver, journaux de modifications et tags (y compris `latest`).
- **Telechargements** sous forme de zip par version.
- **Etoiles et commentaires** pour les retours de la communaute.
- **Moderation** avec des points d’ancrage pour les validations et les audits.
- **API adaptee a la CLI** pour l’automatisation et le scripting.

## Securite et moderation

ClawHub est ouvert par defaut. Tout le monde peut televerser des Skills, mais un compte GitHub doit avoir au moins une semaine pour publier. Cela aide a ralentir les abus sans bloquer les contributeurs legitimes.

Signalement et moderation :

- Tout utilisateur connecte peut signaler un Skill.
- Les raisons de signalement sont obligatoires et enregistrees.
- Chaque utilisateur peut avoir jusqu’a 20 signalements actifs a la fois.
- Les Skills ayant plus de 3 signalements uniques sont automatiquement masques par defaut.
- Les moderateurs peuvent voir les Skills masques, les demasquer, les supprimer ou bannir des utilisateurs.
- L’abus de la fonctionnalite de signalement peut entrainer des bannissements de compte.

Vous souhaitez devenir moderateur ? Demandez sur le Discord OpenClaw et contactez un moderateur ou un mainteneur.

## Commandes et parametres CLI

Options globales (s’appliquent a toutes les commandes) :

- `--workdir <dir>` : Repertoire de travail (par defaut : repertoire courant ; bascule vers l’espace de travail OpenClaw).
- `--dir <dir>` : Repertoire des Skills, relatif au workdir (par defaut : `skills`).
- `--site <url>` : URL de base du site (connexion via navigateur).
- `--registry <url>` : URL de base de l’API du registre.
- `--no-input` : Desactiver les invites (non interactif).
- `-V, --cli-version` : Afficher la version de la CLI.

Authentification :

- `clawhub login` (flux navigateur) ou `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

Options :

- `--token <token>` : Coller un jeton API.
- `--label <label>` : Libelle stocke pour les jetons de connexion via navigateur (par defaut : `CLI token`).
- `--no-browser` : Ne pas ouvrir de navigateur (necessite `--token`).

Recherche :

- `clawhub search "query"`
- `--limit <n>` : Nombre maximal de resultats.

Installation :

- `clawhub install <slug>`
- `--version <version>` : Installer une version specifique.
- `--force` : Ecraser si le dossier existe deja.

Mise a jour :

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>` : Mettre a jour vers une version specifique (un seul slug).
- `--force` : Ecraser lorsque les fichiers locaux ne correspondent a aucune version publiee.

Lister :

- `clawhub list` (lit `.clawhub/lock.json`)

Publier :

- `clawhub publish <path>`
- `--slug <slug>` : Slug du Skill.
- `--name <name>` : Nom d’affichage.
- `--version <version>` : Version semver.
- `--changelog <text>` : Texte du journal des modifications (peut etre vide).
- `--tags <tags>` : Tags separes par des virgules (par defaut : `latest`).

Supprimer/restaurer (proprietaire/admin uniquement) :

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

Synchroniser (analyser les Skills locaux + publier les nouveaux/mis a jour) :

- `clawhub sync`
- `--root <dir...>` : Racines d’analyse supplementaires.
- `--all` : Televerser tout sans invites.
- `--dry-run` : Afficher ce qui serait televerse.
- `--bump <type>` : `patch|minor|major` pour les mises a jour (par defaut : `patch`).
- `--changelog <text>` : Journal des modifications pour les mises a jour non interactives.
- `--tags <tags>` : Tags separes par des virgules (par defaut : `latest`).
- `--concurrency <n>` : Verifications du registre (par defaut : 4).

## Flux de travail courants pour les agents

### Rechercher des Skills

```bash
clawhub search "postgres backups"
```

### Telecharger de nouveaux Skills

```bash
clawhub install my-skill-pack
```

### Mettre a jour les Skills installes

```bash
clawhub update --all
```

### Sauvegarder vos Skills (publier ou synchroniser)

Pour un seul dossier de Skill :

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

Pour analyser et sauvegarder de nombreux Skills a la fois :

```bash
clawhub sync --all
```

## Details avances (techniques)

### Versionnage et tags

- Chaque publication cree un nouveau `SkillVersion` **semver**.
- Les tags (comme `latest`) pointent vers une version ; deplacer les tags permet de revenir en arriere.
- Les journaux des modifications sont attaches par version et peuvent etre vides lors de la synchronisation ou de la publication de mises a jour.

### Modifications locales vs versions du registre

Les mises a jour comparent le contenu local du Skill aux versions du registre a l’aide d’un hash de contenu. Si les fichiers locaux ne correspondent a aucune version publiee, la CLI demande confirmation avant d’ecraser (ou exige `--force` lors d’executions non interactives).

### Analyse de synchronisation et racines de secours

`clawhub sync` analyse d’abord votre workdir actuel. Si aucun Skill n’est trouve, il bascule vers des emplacements historiques connus (par exemple `~/openclaw/skills` et `~/.openclaw/skills`). Cela est concu pour trouver d’anciennes installations de Skills sans options supplementaires.

### Stockage et fichier de verrouillage

- Les Skills installes sont enregistres dans `.clawhub/lock.json` sous votre workdir.
- Les jetons d’authentification sont stockes dans le fichier de configuration de la CLI ClawHub (remplacement via `CLAWHUB_CONFIG_PATH`).

### Telemetrie (comptes d’installation)

Lorsque vous executez `clawhub sync` en etant connecte, la CLI envoie un instantane minimal pour calculer les comptes d’installation. Vous pouvez desactiver cela completement :

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## Variables d’environnement

- `CLAWHUB_SITE` : Remplacer l’URL du site.
- `CLAWHUB_REGISTRY` : Remplacer l’URL de l’API du registre.
- `CLAWHUB_CONFIG_PATH` : Remplacer l’emplacement ou la CLI stocke le jeton/la configuration.
- `CLAWHUB_WORKDIR` : Remplacer le workdir par defaut.
- `CLAWHUB_DISABLE_TELEMETRY=1` : Desactiver la telemetrie sur `sync`.
