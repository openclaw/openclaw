---
summary: "Ce que contient l'invite système OpenClaw et comment elle est assemblée"
read_when:
  - Éditer le texte d'invite système, la liste d'outils ou les sections temps/heartbeat
  - Changer le comportement d'amorçage d'espace de travail ou d'injection de compétences
title: "Invite système"
---

# Invite système

OpenClaw construit une invite système personnalisée pour chaque exécution d'agent. L'invite est **possédée par OpenClaw** et n'utilise pas l'invite par défaut de pi-coding-agent.

L'invite est assemblée par OpenClaw et injectée dans chaque exécution d'agent.

## Structure

L'invite est intentionnellement compacte et utilise des sections fixes :

- **Outillage** : liste d'outils actuelle + descriptions courtes.
- **Sécurité** : rappel de garde-fou court pour éviter un comportement de recherche de pouvoir ou de contournement de surveillance.
- **Compétences** (quand disponibles) : dit au modèle comment charger les instructions de compétence sur demande.
- **Auto-mise à jour OpenClaw** : comment exécuter `config.apply` et `update.run`.
- **Espace de travail** : répertoire de travail (`agents.defaults.workspace`).
- **Documentation** : chemin local vers les docs OpenClaw (dépôt ou package npm) et quand les lire.
- **Fichiers d'espace de travail (injectés)** : indique que les fichiers d'amorçage sont inclus ci-dessous.
- **sandbox** (quand activé) : indique l'environnement d'exécution en sandbox, les chemins de sandbox, et si l'exec élevé est disponible.
- **Date et heure actuelles** : heure locale utilisateur, fuseau horaire et format d'heure.
- **Balises de réponse** : syntaxe optionnelle de balise de réponse pour les fournisseurs supportés.
- **Heartbeats** : invite de heartbeat et comportement d'ack.
- **Environnement d'exécution** : hôte, OS, node, modèle, racine de dépôt (quand détectée), niveau de réflexion (une ligne).
- **Raisonnement** : niveau de visibilité actuel + indication de bascule /reasoning.

Les garde-fous de sécurité dans l'invite système sont consultatifs. Ils guident le comportement du modèle mais n'appliquent pas de politique. Utilisez la politique d'outil, les approbations exec, le sandboxing et les listes blanches de canal pour une application dure ; les opérateurs peuvent désactiver ceux-ci par conception.

## Modes d'invite

OpenClaw peut rendre des invites système plus petites pour les sous-agents. L'environnement d'exécution définit un
`promptMode` pour chaque exécution (pas une config visible par l'utilisateur) :

- `full` (par défaut) : inclut toutes les sections ci-dessus.
- `minimal` : utilisé pour les sous-agents ; omet **Compétences**, **Rappel de mémoire**, **Auto-mise à jour OpenClaw**, **Alias de modèles**, **Identité utilisateur**, **Balises de réponse**,
  **Messagerie**, **Réponses silencieuses** et **Heartbeats**. L'outillage, **Sécurité**,
  Espace de travail, sandbox, Date et heure actuelles (quand connues), Environnement d'exécution et contexte
  injecté restent disponibles.
- `none` : retourne uniquement la ligne d'identité de base.

Quand `promptMode=minimal`, les invites injectées supplémentaires sont étiquetées **Contexte de sous-agent**
au lieu de **Contexte de chat de groupe**.

## Injection d'amorçage d'espace de travail

Les fichiers d'amorçage sont rognés et ajoutés sous **Contexte de projet** pour que le modèle voie l'identité et le contexte de profil sans avoir besoin de lectures explicites :

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (uniquement sur les tout nouveaux espaces de travail)
- `MEMORY.md` et/ou `memory.md` (quand présents dans l'espace de travail ; l'un ou les deux peuvent être injectés)

Tous ces fichiers sont **injectés dans la fenêtre de contexte** à chaque tour, ce qui
signifie qu'ils consomment des jetons. Gardez-les concis — surtout `MEMORY.md`, qui peut
grandir avec le temps et conduire à une utilisation de contexte inhabituellement élevée et une compaction plus fréquente.

> **Note :** Les fichiers quotidiens `memory/*.md` ne sont **pas** injectés automatiquement. Ils
> sont accessibles sur demande via les outils `memory_search` et `memory_get`, donc ils
> ne comptent pas contre la fenêtre de contexte sauf si le modèle les lit explicitement.

Les gros fichiers sont tronqués avec un marqueur. La taille max par fichier est contrôlée par
`agents.defaults.bootstrapMaxChars` (par défaut : 20000). Le contenu d'amorçage injecté total
à travers les fichiers est plafonné par `agents.defaults.bootstrapTotalMaxChars`
(par défaut : 24000). Les fichiers manquants injectent un court marqueur de fichier manquant.

Les sessions de sous-agent injectent uniquement `AGENTS.md` et `TOOLS.md` (les autres fichiers d'amorçage
sont filtrés pour garder le contexte de sous-agent petit).

Les hooks internes peuvent intercepter cette étape via `agent:bootstrap` pour muter ou remplacer
les fichiers d'amorçage injectés (par exemple échanger `SOUL.md` pour une personnalité alternative).

Pour inspecter combien chaque fichier injecté contribue (brut vs injecté, troncature, plus surcharge de schéma d'outil), utilisez `/context list` ou `/context detail`. Voir [Contexte](/fr-FR/concepts/context).

## Gestion du temps

L'invite système inclut une section dédiée **Date et heure actuelles** quand le
fuseau horaire utilisateur est connu. Pour garder le cache d'invite stable, elle n'inclut maintenant que
le **fuseau horaire** (pas d'horloge dynamique ou de format d'heure).

Utilisez `session_status` quand l'agent a besoin de l'heure actuelle ; la carte de statut
inclut une ligne de timestamp.

Configurez avec :

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

Voir [Date et heure](/fr-FR/date-time) pour les détails complets de comportement.

## Compétences

Quand des compétences éligibles existent, OpenClaw injecte une **liste de compétences disponibles** compacte
(`formatSkillsForPrompt`) qui inclut le **chemin de fichier** pour chaque compétence. L'invite
instruit le modèle à utiliser `read` pour charger le SKILL.md à l'emplacement listé
(espace de travail, géré ou intégré). S'il n'y a pas de compétences éligibles, la
section Compétences est omise.

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

Cela garde l'invite de base petite tout en permettant toujours l'utilisation ciblée de compétences.

## Documentation

Quand disponible, l'invite système inclut une section **Documentation** qui pointe vers le
répertoire de docs OpenClaw local (soit `docs/` dans l'espace de travail du dépôt soit le package npm
intégré docs) et note aussi le miroir public, le dépôt source, le Discord communauté, et
ClawHub ([https://clawhub.com](https://clawhub.com)) pour la découverte de compétences. L'invite instruit le modèle à consulter les docs locales d'abord
pour le comportement OpenClaw, les commandes, la configuration ou l'architecture, et à exécuter
`openclaw status` lui-même quand possible (demander à l'utilisateur uniquement quand il manque d'accès).
