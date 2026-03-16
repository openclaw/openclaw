---
summary: "Contexte : ce que le modèle voit, comment il est construit et comment l'inspecter"
read_when:
  - Vous voulez comprendre ce que signifie "contexte" dans OpenClaw
  - Vous déboguez pourquoi le modèle "sait" quelque chose (ou l'a oublié)
  - Vous voulez réduire la surcharge de contexte (/context, /status, /compact)
title: "Contexte"
---

# Contexte

Le "contexte" est **tout ce qu'OpenClaw envoie au modèle pour une exécution**. Il est délimité par la **fenêtre de contexte** du modèle (limite de jetons).

Modèle mental pour débutant :

- **Invite système** (construite par OpenClaw) : règles, outils, liste de compétences, temps/exécution et fichiers d'espace de travail injectés.
- **Historique de conversation** : vos messages + les messages de l'assistant pour cette session.
- **Appels/résultats d'outils + pièces jointes** : sortie de commande, lectures de fichiers, images/audio, etc.

Le contexte n'est _pas la même chose_ que la "mémoire" : la mémoire peut être stockée sur disque et rechargée plus tard ; le contexte est ce qui est dans la fenêtre actuelle du modèle.

## Démarrage rapide (inspecter le contexte)

- `/status` → vue rapide "à quel point ma fenêtre est-elle pleine ?" + paramètres de session.
- `/context list` → ce qui est injecté + tailles approximatives (par fichier + totaux).
- `/context detail` → décomposition plus profonde : par fichier, tailles de schéma d'outil par outil, tailles d'entrée de compétence par compétence et taille d'invite système.
- `/usage tokens` → ajoute un pied de page d'utilisation par réponse aux réponses normales.
- `/compact` → résume l'historique plus ancien en une entrée compacte pour libérer de l'espace de fenêtre.

Voir aussi : [Commandes slash](/fr-FR/tools/slash-commands), [Utilisation de jetons et coûts](/fr-FR/reference/token-use), [Compaction](/fr-FR/concepts/compaction).

## Exemple de sortie

Les valeurs varient selon le modèle, le fournisseur, la politique d'outils et ce qui est dans votre espace de travail.

### `/context list`

```
🧠 Décomposition du contexte
Espace de travail : <workspaceDir>
Bootstrap max/fichier : 20 000 chars
sandbox : mode=non-main sandboxed=false
Invite système (exécution) : 38 412 chars (~9 603 tok) (Contexte de projet 23 901 chars (~5 976 tok))

Fichiers d'espace de travail injectés :
- AGENTS.md: OK | brut 1 742 chars (~436 tok) | injecté 1 742 chars (~436 tok)
- SOUL.md: OK | brut 912 chars (~228 tok) | injecté 912 chars (~228 tok)
- TOOLS.md: TRONQUÉ | brut 54 210 chars (~13 553 tok) | injecté 20 962 chars (~5 241 tok)
- IDENTITY.md: OK | brut 211 chars (~53 tok) | injecté 211 chars (~53 tok)
- USER.md: OK | brut 388 chars (~97 tok) | injecté 388 chars (~97 tok)
- HEARTBEAT.md: MANQUANT | brut 0 | injecté 0
- BOOTSTRAP.md: OK | brut 0 chars (~0 tok) | injecté 0 chars (~0 tok)

Liste de compétences (texte d'invite système) : 2 184 chars (~546 tok) (12 compétences)
Outils : read, edit, write, exec, process, browser, message, sessions_send, …
Liste d'outils (texte d'invite système) : 1 032 chars (~258 tok)
Schémas d'outils (JSON) : 31 988 chars (~7 997 tok) (compte pour le contexte ; non affiché comme texte)
Outils : (les mêmes que ci-dessus)

Jetons de session (en cache) : 14 250 total / ctx=32 000
```

### `/context detail`

```
🧠 Décomposition du contexte (détaillée)
…
Principales compétences (taille d'entrée d'invite) :
- frontend-design : 412 chars (~103 tok)
- oracle : 401 chars (~101 tok)
… (+10 compétences supplémentaires)

Principaux outils (taille de schéma) :
- browser : 9 812 chars (~2 453 tok)
- exec : 6 240 chars (~1 560 tok)
… (+N outils supplémentaires)
```

## Ce qui compte pour la fenêtre de contexte

Tout ce que le modèle reçoit compte, incluant :

- Invite système (toutes les sections).
- Historique de conversation.
- Appels d'outils + résultats d'outils.
- Pièces jointes/transcriptions (images/audio/fichiers).
- Résumés de compaction et artefacts d'élagage.
- "Enveloppes" de fournisseur ou en-têtes cachés (non visibles, toujours comptés).

## Comment OpenClaw construit l'invite système

L'invite système est **possédée par OpenClaw** et reconstruite à chaque exécution. Elle inclut :

- Liste d'outils + courtes descriptions.
- Liste de compétences (métadonnées uniquement ; voir ci-dessous).
- Emplacement de l'espace de travail.
- Temps (UTC + temps utilisateur converti si configuré).
- Métadonnées d'exécution (hôte/OS/modèle/thinking).
- Fichiers d'amorçage d'espace de travail injectés sous **Contexte de projet**.

Décomposition complète : [Invite système](/fr-FR/concepts/system-prompt).

## Fichiers d'espace de travail injectés (Contexte de projet)

Par défaut, OpenClaw injecte un ensemble fixe de fichiers d'espace de travail (s'ils sont présents) :

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (première exécution uniquement)

Les gros fichiers sont tronqués par fichier en utilisant `agents.defaults.bootstrapMaxChars` (par défaut `20000` caractères). OpenClaw applique aussi un plafond total d'injection d'amorçage à travers les fichiers avec `agents.defaults.bootstrapTotalMaxChars` (par défaut `24000` caractères). `/context` montre les tailles **brutes vs injectées** et si la troncation s'est produite.

## Compétences : ce qui est injecté vs chargé à la demande

L'invite système inclut une **liste de compétences** compacte (nom + description + emplacement). Cette liste a un réel coût.

Les instructions de compétence ne sont _pas_ incluses par défaut. Le modèle est censé `read` le `SKILL.md` de la compétence **uniquement quand nécessaire**.

## Outils : il y a deux coûts

Les outils affectent le contexte de deux façons :

1. **Texte de liste d'outils** dans l'invite système (ce que vous voyez comme "Outillage").
2. **Schémas d'outils** (JSON). Ceux-ci sont envoyés au modèle pour qu'il puisse appeler des outils. Ils comptent pour le contexte même si vous ne les voyez pas comme texte brut.

`/context detail` décompose les plus gros schémas d'outils pour que vous puissiez voir ce qui domine.

## Commandes, directives et "raccourcis en ligne"

Les commandes slash sont gérées par la Passerelle. Il y a quelques comportements différents :

- **Commandes autonomes** : un message qui est seulement `/...` s'exécute comme une commande.
- **Directives** : `/think`, `/verbose`, `/reasoning`, `/elevated`, `/model`, `/queue` sont retirés avant que le modèle ne voie le message.
  - Les messages directive-seulement persistent les paramètres de session.
  - Les directives en ligne dans un message normal agissent comme indices par message.
- **Raccourcis en ligne** (expéditeurs sur liste autorisée uniquement) : certains jetons `/...` dans un message normal peuvent s'exécuter immédiatement (exemple : "hey /status"), et sont retirés avant que le modèle ne voie le texte restant.

Détails : [Commandes slash](/fr-FR/tools/slash-commands).

## Sessions, compaction et élagage (ce qui persiste)

Ce qui persiste à travers les messages dépend du mécanisme :

- **Historique normal** persiste dans la transcription de session jusqu'à compaction/élagage par politique.
- **Compaction** persiste un résumé dans la transcription et garde les messages récents intacts.
- **Élagage** retire les anciens résultats d'outils de l'invite _en mémoire_ pour une exécution, mais ne réécrit pas la transcription.

Docs : [Session](/fr-FR/concepts/session), [Compaction](/fr-FR/concepts/compaction), [Élagage de session](/fr-FR/concepts/session-pruning).

## Ce que `/context` rapporte réellement

`/context` préfère le dernier rapport d'invite système **construit pour l'exécution** quand disponible :

- `System prompt (run)` = capturé depuis la dernière exécution embarquée (capable d'outils) et persisté dans le magasin de session.
- `System prompt (estimate)` = calculé à la volée quand aucun rapport d'exécution n'existe (ou lors de l'exécution via un backend CLI qui ne génère pas le rapport).

Dans tous les cas, il rapporte les tailles et les principaux contributeurs ; il ne **vide pas** l'invite système complète ou les schémas d'outils.
