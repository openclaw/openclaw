---
summary: "Contexte : ce que le modèle voit, comment il est construit et comment l’inspecter"
read_when:
  - Vous voulez comprendre ce que signifie le « contexte » dans OpenClaw
  - Vous depannez pourquoi le modele « sait » quelque chose (ou l’a oublie)
  - Vous voulez reduire la surcharge de contexte (/context, /status, /compact)
title: "Contexte"
---

# Contexte

Le « contexte » est **tout ce qu’OpenClaw envoie au modele pour une execution**. Il est borne par la **fenetre de contexte** du modele (limite de tokens).

Modele mental pour debutants :

- **Invite systeme** (construite par OpenClaw) : regles, outils, liste des Skills, heure/environnement d’execution et fichiers d’espace de travail injectes.
- **Historique de conversation** : vos messages + les messages de l’assistant pour cette session.
- **Appels/resultats d’outils + pieces jointes** : sorties de commandes, lectures de fichiers, images/audio, etc.

Le contexte _n’est pas la meme chose_ que la « memoire » : la memoire peut etre stockee sur disque et rechargee plus tard ; le contexte est ce qui se trouve dans la fenetre courante du modele.

## Demarrage rapide (inspecter le contexte)

- `/status` → vue rapide « a quel point ma fenetre est-elle remplie ? » + parametres de session.
- `/context list` → ce qui est injecte + tailles approximatives (par fichier + totaux).
- `/context detail` → detail approfondi : tailles par fichier, par schema d’outil, par entree de Skill, et taille de l’invite systeme.
- `/usage tokens` → ajouter un pied de page d’utilisation par reponse aux reponses normales.
- `/compact` → resumer l’historique plus ancien en une entree compacte pour liberer de l’espace de fenetre.

Voir aussi : [Commandes slash](/tools/slash-commands), [Utilisation des tokens et couts](/token-use), [Compaction](/concepts/compaction).

## Exemple de sortie

Les valeurs varient selon le modele, le fournisseur, la politique d’outils et le contenu de votre espace de travail.

### `/context list`

```
🧠 Context breakdown
Workspace: <workspaceDir>
Bootstrap max/file: 20,000 chars
Sandbox: mode=non-main sandboxed=false
System prompt (run): 38,412 chars (~9,603 tok) (Project Context 23,901 chars (~5,976 tok))

Injected workspace files:
- AGENTS.md: OK | raw 1,742 chars (~436 tok) | injected 1,742 chars (~436 tok)
- SOUL.md: OK | raw 912 chars (~228 tok) | injected 912 chars (~228 tok)
- TOOLS.md: TRUNCATED | raw 54,210 chars (~13,553 tok) | injected 20,962 chars (~5,241 tok)
- IDENTITY.md: OK | raw 211 chars (~53 tok) | injected 211 chars (~53 tok)
- USER.md: OK | raw 388 chars (~97 tok) | injected 388 chars (~97 tok)
- HEARTBEAT.md: MISSING | raw 0 | injected 0
- BOOTSTRAP.md: OK | raw 0 chars (~0 tok) | injected 0 chars (~0 tok)

Skills list (system prompt text): 2,184 chars (~546 tok) (12 skills)
Tools: read, edit, write, exec, process, browser, message, sessions_send, …
Tool list (system prompt text): 1,032 chars (~258 tok)
Tool schemas (JSON): 31,988 chars (~7,997 tok) (counts toward context; not shown as text)
Tools: (same as above)

Session tokens (cached): 14,250 total / ctx=32,000
```

### `/context detail`

```
🧠 Context breakdown (detailed)
…
Top skills (prompt entry size):
- frontend-design: 412 chars (~103 tok)
- oracle: 401 chars (~101 tok)
… (+10 more skills)

Top tools (schema size):
- browser: 9,812 chars (~2,453 tok)
- exec: 6,240 chars (~1,560 tok)
… (+N more tools)
```

## Ce qui compte dans la fenetre de contexte

Tout ce que le modele recoit compte, notamment :

- Invite systeme (toutes les sections).
- Historique de conversation.
- Appels d’outils + resultats d’outils.
- Pieces jointes/transcriptions (images/audio/fichiers).
- Resumes de compaction et artefacts d’elagage.
- « Wrappers » du fournisseur ou en-tetes caches (non visibles, mais comptabilises).

## Comment OpenClaw construit l’invite systeme

L’invite systeme est **geree par OpenClaw** et reconstruite a chaque execution. Elle inclut :

- Liste des outils + descriptions courtes.
- Liste des Skills (metadonnees uniquement ; voir ci-dessous).
- Emplacement de l’espace de travail.
- Heure (UTC + heure utilisateur convertie si configuree).
- Metadonnees d’execution (hote/OS/modele/reflexion).
- Fichiers de demarrage de l’espace de travail injectes sous **Project Context**.

Detail complet : [Invite systeme](/concepts/system-prompt).

## Fichiers d’espace de travail injectes (Project Context)

Par defaut, OpenClaw injecte un ensemble fixe de fichiers de l’espace de travail (s’ils sont presents) :

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (premiere execution uniquement)

Les fichiers volumineux sont tronques par fichier a l’aide de `agents.defaults.bootstrapMaxChars` (par defaut `20000` caracteres). `/context` affiche les tailles **brutes vs injectees** et indique si une troncature a eu lieu.

## Skills : ce qui est injecte vs charge a la demande

L’invite systeme inclut une **liste de Skills** compacte (nom + description + emplacement). Cette liste a un cout reel.

Les instructions des Skills ne sont _pas_ incluses par defaut. Le modele est cense `read` le `SKILL.md` du Skill **uniquement lorsque necessaire**.

## Outils : il y a deux couts

Les outils affectent le contexte de deux manieres :

1. **Texte de la liste d’outils** dans l’invite systeme (ce que vous voyez comme « Tooling »).
2. **Schemas d’outils** (JSON). Ils sont envoyes au modele pour qu’il puisse appeler les outils. Ils comptent dans le contexte meme si vous ne les voyez pas comme du texte brut.

`/context detail` detaille les schemas d’outils les plus volumineux afin que vous puissiez voir ce qui domine.

## Commandes, directives et « raccourcis inline »

Les commandes slash sont gerees par la Gateway (passerelle). Il existe plusieurs comportements :

- **Commandes autonomes** : un message qui est uniquement `/...` s’execute comme une commande.
- **Directives** : `/think`, `/verbose`, `/reasoning`, `/elevated`, `/model`, `/queue` sont supprimees avant que le modele ne voie le message.
  - Les messages ne contenant que des directives conservent les parametres de session.
  - Les directives inline dans un message normal agissent comme des indications par message.
- **Raccourcis inline** (expediteurs autorises uniquement) : certains tokens `/...` a l’interieur d’un message normal peuvent s’executer immediatement (exemple : « hey /status ») et sont supprimes avant que le modele ne voie le texte restant.

Details : [Commandes slash](/tools/slash-commands).

## Sessions, compaction et elagage (ce qui persiste)

Ce qui persiste d’un message a l’autre depend du mecanisme :

- **Historique normal** : persiste dans la transcription de session jusqu’a etre compacte/elague selon la politique.
- **Compaction** : conserve un resume dans la transcription et garde les messages recents intacts.
- **Elagage** : supprime les anciens resultats d’outils de l’invite _en memoire_ pour une execution, mais ne reecrit pas la transcription.

Documentation : [Session](/concepts/session), [Compaction](/concepts/compaction), [Elagage de session](/concepts/session-pruning).

## Ce que `/context` rapporte reellement

`/context` privilegie le rapport d’invite systeme **construit lors de l’execution** le plus recent lorsqu’il est disponible :

- `System prompt (run)` = capture a partir de la derniere execution embarquee (avec outils) et conservee dans le stockage de session.
- `System prompt (estimate)` = calcule a la volee lorsqu’aucun rapport d’execution n’existe (ou lors d’une execution via un backend CLI qui ne genere pas le rapport).

Dans tous les cas, il rapporte les tailles et les principaux contributeurs ; il ne **deverse pas** l’invite systeme complete ni les schemas d’outils.
