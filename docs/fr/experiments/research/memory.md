---
summary: "Notes de recherche : systeme de memoire hors ligne pour les espaces de travail Clawd (source de verite Markdown + index derive)"
read_when:
  - Conception de la memoire d’espace de travail (~/.openclaw/workspace) au-dela des journaux Markdown quotidiens
  - Deciding: "Choix: CLI autonome vs integration profonde a OpenClaw"
  - Ajout du rappel hors ligne + reflexion (retain/recall/reflect)
title: "Recherche sur la memoire d’espace de travail"
---

# Memoire d’espace de travail v2 (hors ligne) : notes de recherche

Cible : espace de travail de style Clawd (`agents.defaults.workspace`, par defaut `~/.openclaw/workspace`) ou la « memoire » est stockee sous forme d’un fichier Markdown par jour (`memory/YYYY-MM-DD.md`) plus un petit ensemble de fichiers stables (par ex. `memory.md`, `SOUL.md`).

Ce document propose une architecture de memoire **offline-first** qui conserve Markdown comme source de verite canonique et revisable, tout en ajoutant un **rappel structure** (recherche, resumes d’entites, mises a jour de confiance) via un index derive.

## Pourquoi changer ?

La configuration actuelle (un fichier par jour) est excellente pour :

- la journalisation « append-only »
- l’edition humaine
- la durabilite + l’auditabilite via git
- la capture a faible friction (« il suffit de l’ecrire »)

Elle est faible pour :

- la recuperation a fort rappel (« qu’avons-nous decide a propos de X ? », « la derniere fois que nous avons essaye Y ? »)
- les reponses centrees sur les entites (« parle-moi d’Alice / The Castle / warelay ») sans relire de nombreux fichiers
- la stabilite des opinions/preferences (et les preuves lors des changements)
- les contraintes temporelles (« qu’est-ce qui etait vrai en nov. 2025 ? ») et la resolution des conflits

## Objectifs de conception

- **Hors ligne** : fonctionne sans reseau ; peut s’executer sur un ordinateur portable/Castle ; aucune dependance au cloud.
- **Explicable** : les elements recuperes doivent etre attribuables (fichier + emplacement) et separables de l’inference.
- **Faible ceremonie** : la journalisation quotidienne reste en Markdown, sans schema lourd.
- **Incremental** : la v1 est utile avec la FTS uniquement ; le semantique/vectoriel et les graphes sont des evolutions optionnelles.
- **Compatible agent** : facilite le « rappel dans des budgets de tokens » (retourner de petits ensembles de faits).

## Modele « north star » (Hindsight × Letta)

Deux pieces a combiner :

1. **Boucle de controle de type Letta/MemGPT**

- conserver un petit « noyau » toujours en contexte (persona + faits cles utilisateur)
- tout le reste est hors contexte et recupere via des outils
- les ecritures de memoire sont des appels d’outils explicites (append/replace/insert), persistes, puis reinjectes au tour suivant

2. **Substrat de memoire de type Hindsight**

- separer ce qui est observe de ce qui est cru de ce qui est resume
- prendre en charge retain/recall/reflect
- des opinions porteuses de confiance qui peuvent evoluer avec les preuves
- recuperation consciente des entites + requetes temporelles (meme sans graphes de connaissances complets)

## Architecture proposee (source de verite Markdown + index derive)

### Magasin canonique (convivial)

Conserver `~/.openclaw/workspace` comme memoire canonique lisible par l’humain.

Disposition suggeree de l’espace de travail :

```
~/.openclaw/workspace/
  memory.md                    # small: durable facts + preferences (core-ish)
  memory/
    YYYY-MM-DD.md              # daily log (append; narrative)
  bank/                        # “typed” memory pages (stable, reviewable)
    world.md                   # objective facts about the world
    experience.md              # what the agent did (first-person)
    opinions.md                # subjective prefs/judgments + confidence + evidence pointers
    entities/
      Peter.md
      The-Castle.md
      warelay.md
      ...
```

Notes :

- **Le journal quotidien reste un journal quotidien**. Pas besoin de le transformer en JSON.
- Les fichiers `bank/` sont **organises**, produits par des taches de reflexion, et peuvent toujours etre edites a la main.
- `memory.md` reste « petit + proche du noyau » : les elements que vous voulez que Clawd voie a chaque session.

### Stockage derive (rappel machine)

Ajouter un index derive sous l’espace de travail (pas necessairement suivi par git) :

```
~/.openclaw/workspace/.memory/index.sqlite
```

Revenir avec :

- un schema SQLite pour les faits + liens d’entites + metadonnees d’opinions
- SQLite **FTS5** pour le rappel lexical (rapide, leger, hors ligne)
- une table d’embeddings optionnelle pour le rappel semantique (toujours hors ligne)

L’index est toujours **reconstructible a partir du Markdown**.

## Retain / Recall / Reflect (boucle operationnelle)

### Retain : normaliser les journaux quotidiens en « faits »

L’intuition cle de Hindsight ici : stocker des **faits narratifs et autonomes**, pas de minuscules extraits.

Regle pratique pour `memory/YYYY-MM-DD.md` :

- en fin de journee (ou pendant), ajouter une section `## Retain` avec 2 a 5 puces qui sont :
  - narratives (le contexte inter-tours est preserve)
  - autonomes (compréhensibles plus tard, seules)
  - etiquetees avec un type + des mentions d’entites

Exemple :

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy’s birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

Analyse minimale :

- Prefixe de type : `W` (monde), `B` (experience/biographique), `O` (opinion), `S` (observation/resume ; generalement genere)
- Entites : `@Peter`, `@warelay`, etc. (les slugs correspondent a `bank/entities/*.md`)
- Confiance de l’opinion : `O(c=0.0..1.0)` optionnelle

Si vous ne voulez pas que les auteurs y pensent : la tache de reflexion peut inferer ces puces a partir du reste du journal, mais disposer d’une section `## Retain` explicite est le levier de qualite le plus simple.

### Recall : requetes sur l’index derive

Le rappel doit prendre en charge :

- **lexical** : « trouver des termes/noms/commandes exacts » (FTS5)
- **entite** : « parle-moi de X » (pages d’entites + faits lies aux entites)
- **temporel** : « que s’est-il passe autour du 27 nov. » / « depuis la semaine derniere »
- **opinion** : « que prefere Peter ? » (avec confiance + preuves)

Le format de retour doit etre compatible agent et citer les sources :

- `kind` (`world|experience|opinion|observation`)
- `timestamp` (jour source, ou plage temporelle extraite si presente)
- `entities` (`["Peter","warelay"]`)
- `content` (le fait narratif)
- `source` (`memory/2025-11-27.md#L12` etc.)

### Reflect : produire des pages stables + mettre a jour les croyances

La reflexion est une tache planifiee (quotidienne ou heartbeat `ultrathink`) qui :

- met a jour `bank/entities/*.md` a partir des faits recents (resumes d’entites)
- met a jour la confiance de `bank/opinions.md` en fonction des renforcements/contradictions
- propose eventuellement des modifications a `memory.md` (faits durables « proches du noyau »)

Evolution des opinions (simple, explicable) :

- chaque opinion a :
  - instruction
  - une confiance `c ∈ [0,1]`
  - un last_updated
  - des liens de preuves (IDs de faits a l’appui + contradictoires)
- lorsque de nouveaux faits arrivent :
  - trouver des opinions candidates par recouvrement d’entites + similarite (FTS d’abord, embeddings ensuite)
  - mettre a jour la confiance par petits deltas ; les grands sauts exigent une forte contradiction + des preuves repetees

## Integration CLI : autonome vs integration profonde

Recommandation : **integration profonde dans OpenClaw**, tout en conservant une bibliotheque cœur separable.

### Pourquoi integrer dans OpenClaw ?

- OpenClaw connait deja :
  - le chemin de l’espace de travail (`agents.defaults.workspace`)
  - le modele de session + les heartbeats
  - les patterns de journalisation + de depannage
- Vous voulez que l’agent lui-meme appelle les outils :
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### Pourquoi quand meme separer une bibliotheque ?

- garder la logique de memoire testable sans passerelle/runtime
- reutiliser dans d’autres contextes (scripts locaux, future application desktop, etc.)

Forme :
L’outillage memoire est concu comme une petite couche CLI + bibliotheque, mais cela reste exploratoire.

## « S-Collide » / SuCo : quand l’utiliser (recherche)

Si « S-Collide » designe **SuCo (Subspace Collision)** : c’est une approche de recuperation ANN qui vise de forts compromis rappel/latence en utilisant des collisions apprises/structurees dans des sous-espaces (article : arXiv 2411.14754, 2024).

Position pragmatique pour `~/.openclaw/workspace` :

- **ne commencez pas** avec SuCo.
- commencez avec SQLite FTS + (optionnellement) des embeddings simples ; vous obtiendrez immediatement la plupart des gains UX.
- envisagez des solutions de classe SuCo/HNSW/ScaNN uniquement lorsque :
  - le corpus est volumineux (des dizaines/centaines de milliers de fragments)
  - la recherche par embeddings en force brute devient trop lente
  - la qualite de rappel est reellement limitee par la recherche lexicale

Alternatives compatibles hors ligne (par complexite croissante) :

- SQLite FTS5 + filtres de metadonnees (zero ML)
- Embeddings + force brute (va etonnamment loin si le nombre de fragments est faible)
- Index HNSW (courant, robuste ; necessite une liaison de bibliotheque)
- SuCo (niveau recherche ; attractif s’il existe une implementation solide integrable)

Question ouverte :

- quel est le **meilleur** modele d’embeddings hors ligne pour une « memoire d’assistant personnel » sur vos machines (portable + bureau) ?
  - si vous avez deja Ollama : produire les embeddings avec un modele local ; sinon, embarquer un petit modele d’embeddings dans la chaine d’outils.

## Plus petit pilote utile

Si vous voulez une version minimale mais utile :

- Ajouter des pages d’entites `bank/` et une section `## Retain` dans les journaux quotidiens.
- Utiliser SQLite FTS pour le rappel avec citations (chemin + numeros de ligne).
- Ajouter des embeddings uniquement si la qualite de rappel ou l’echelle l’exigent.

## References

- Concepts Letta / MemGPT : « core memory blocks » + « archival memory » + memoire auto-editable pilotee par outils.
- Rapport technique Hindsight : « retain / recall / reflect », memoire a quatre reseaux, extraction de faits narratifs, evolution de la confiance des opinions.
- SuCo : arXiv 2411.14754 (2024) : « Subspace Collision » pour la recuperation de plus proches voisins approximate.
