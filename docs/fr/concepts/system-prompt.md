---
summary: "Ce que contient le prompt systeme OpenClaw et comment il est assemble"
read_when:
  - Modification du texte du prompt systeme, de la liste d’outils ou des sections temps/heartbeat
  - Changement du bootstrap de l’espace de travail ou du comportement d’injection des Skills
title: "Prompt systeme"
---

# Prompt systeme

OpenClaw construit un prompt systeme personnalise pour chaque execution d’agent. Le prompt est **propriete d’OpenClaw** et n’utilise pas le prompt par defaut de p-coding-agent.

Le prompt est assemble par OpenClaw et injecte dans chaque execution d’agent.

## Structure

Le prompt est volontairement compact et utilise des sections fixes :

- **Tooling** : liste d’outils courante + courtes descriptions.
- **Safety** : bref rappel de garde-fous pour eviter les comportements de recherche de pouvoir ou le contournement de la supervision.
- **Skills** (le cas echeant) : indique au modele comment charger les instructions de Skills a la demande.
- **OpenClaw Self-Update** : comment executer `config.apply` et `update.run`.
- **Workspace** : repertoire de travail (`agents.defaults.workspace`).
- **Documentation** : chemin local vers la documentation OpenClaw (depot ou package npm) et quand la consulter.
- **Workspace Files (injected)** : indique que les fichiers de bootstrap sont inclus ci-dessous.
- **Sandbox** (lorsqu’active) : indique l’execution en sandbox, les chemins de sandbox et si une execution elevee est disponible.
- **Current Date & Time** : heure locale utilisateur, fuseau horaire et format de l’heure.
- **Reply Tags** : syntaxe optionnelle de tags de reponse pour les fournisseurs pris en charge.
- **Heartbeats** : prompt de heartbeat et comportement d’accuse de reception.
- **Runtime** : hote, OS, node, modele, racine du depot (si detectee), niveau de reflexion (une ligne).
- **Reasoning** : niveau de visibilite actuel + indication du basculement /reasoning.

Les garde-fous de securite du prompt systeme sont consultatifs. Ils guident le comportement du modele mais n’appliquent pas de politique. Utilisez les politiques d’outils, les approbations d’execution, le sandboxing et les listes blanches de canaux pour une application stricte ; les operateurs peuvent les desactiver par conception.

## Modes de prompt

OpenClaw peut produire des prompts systeme plus petits pour des sous-agents. Le runtime definit un
`promptMode` pour chaque execution (non expose a l’utilisateur) :

- `full` (par defaut) : inclut toutes les sections ci-dessus.
- `minimal` : utilise pour les sous-agents ; omet **Skills**, **Memory Recall**, **OpenClaw
  Self-Update**, **Model Aliases**, **User Identity**, **Reply Tags**,
  **Messaging**, **Silent Replies** et **Heartbeats**. Tooling, **Safety**,
  Workspace, Sandbox, Current Date & Time (lorsqu’il est connu), Runtime et le contexte
  injecte restent disponibles.
- `none` : renvoie uniquement la ligne d’identite de base.

Lorsque `promptMode=minimal`, les prompts supplementaires injectes sont libelles **Subagent
Context** au lieu de **Group Chat Context**.

## Injection du bootstrap de l’espace de travail

Les fichiers de bootstrap sont tronques et ajoutes sous **Project Context** afin que le modele voie le contexte d’identite et de profil sans lectures explicites :

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (uniquement sur les espaces de travail tout neufs)

Les fichiers volumineux sont tronques avec un marqueur. La taille maximale par fichier est controlee par
`agents.defaults.bootstrapMaxChars` (par defaut : 20000). Les fichiers manquants injectent un
court marqueur de fichier manquant.

Des hooks internes peuvent intercepter cette etape via `agent:bootstrap` pour modifier ou remplacer
les fichiers de bootstrap injectes (par exemple en remplaçant `SOUL.md` par une persona alternative).

Pour inspecter la contribution de chaque fichier injecte (brut vs injecte, troncature, plus la surcharge du schema d’outil), utilisez `/context list` ou `/context detail`. Voir [Context](/concepts/context).

## Gestion du temps

Le prompt systeme inclut une section **Current Date & Time** dediee lorsque le
fuseau horaire utilisateur est connu. Pour conserver la stabilite du cache du prompt, il n’inclut
desormais que le **fuseau horaire** (pas d’horloge dynamique ni de format de l’heure).

Utilisez `session_status` lorsque l’agent a besoin de l’heure courante ; la carte d’etat
inclut une ligne d’horodatage.

Configurez avec :

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

Voir [Date & Time](/date-time) pour les details complets de comportement.

## Skills

Lorsque des skills eligibles existent, OpenClaw injecte une **liste compacte des skills disponibles**
(`formatSkillsForPrompt`) qui inclut le **chemin du fichier** pour chaque skill. Le
prompt indique au modele d’utiliser `read` pour charger le SKILL.md a l’emplacement indique
(espace de travail, gere ou integre). S’il n’y a aucun skill eligible, la section
Skills est omise.

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

Cela permet de garder le prompt de base concis tout en activant une utilisation ciblee des skills.

## Documentation

Lorsqu’elle est disponible, le prompt systeme inclut une section **Documentation** qui pointe vers le
repertoire local de documentation OpenClaw (soit `docs/` dans l’espace de travail du depot, soit la documentation du package npm
integree) et mentionne egalement le miroir public, le depot source, le Discord communautaire et
ClawHub (https://clawhub.com) pour la decouverte de skills. Le prompt indique au modele de consulter en priorite la documentation locale
pour le comportement, les commandes, la configuration ou l’architecture d’OpenClaw, et d’executer
`openclaw status` lui-meme lorsque possible (en demandant a l’utilisateur uniquement lorsqu’il n’y a pas acces).
