---
title: Verification formelle (modeles de securite)
summary: Modeles de securite verifies par machine pour les parcours a plus haut risque d’OpenClaw.
permalink: /security/formal-verification/
x-i18n:
  source_path: security/formal-verification.md
  source_hash: 8dff6ea41a37fb6b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:02:58Z
---

# Verification formelle (modeles de securite)

Cette page suit les **modeles de securite formels** d’OpenClaw (TLA+/TLC aujourd’hui ; d’autres au besoin).

> Note : certains liens plus anciens peuvent faire reference a l’ancien nom du projet.

**Objectif (etoile polaire) :** fournir un argument verifie par machine attestant qu’OpenClaw applique sa
politique de securite voulue (autorisation, isolation de session, controle d’acces aux outils et
securite face aux mauvaises configurations), sous des hypotheses explicites.

**Ce que c’est (aujourd’hui) :** une **suite de regression de securite** executable, orientee attaquant :

- Chaque affirmation dispose d’une verification par model-checking executable sur un espace d’etats fini.
- De nombreuses affirmations ont un **modele negatif** associe qui produit une trace de contre-exemple pour une classe de bogues realiste.

**Ce que ce n’est pas (encore) :** une preuve que « OpenClaw est securise a tous egards » ni que l’implementation TypeScript complete est correcte.

## Ou se trouvent les modeles

Les modeles sont maintenus dans un depot separe : [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models).

## Mises en garde importantes

- Il s’agit de **modeles**, pas de l’implementation TypeScript complete. Un ecart entre modele et code est possible.
- Les resultats sont limites par l’espace d’etats explore par TLC ; un statut « vert » n’implique pas une securite au-dela des hypotheses et bornes modelisees.
- Certaines affirmations reposent sur des hypotheses environnementales explicites (p. ex., deploiement correct, entrees de configuration correctes).

## Reproduire les resultats

Aujourd’hui, les resultats se reproduisent en clonant localement le depot des modeles et en executant TLC (voir ci-dessous). Une iteration future pourrait proposer :

- des modeles executes en CI avec des artefacts publics (traces de contre-exemples, journaux d’execution) ;
- un flux de travail heberge « executer ce modele » pour des verifications petites et bornees.

Premiers pas :

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.

make <target>
```

### Exposition de la Gateway (passerelle) et mauvaise configuration d’une gateway ouverte

**Affirmation :** un bind au-dela du loopback sans authentification peut rendre une compromission distante possible / augmenter l’exposition ; un jeton/mot de passe bloque les attaquants non authentifies (selon les hypotheses du modele).

- Executions vertes :
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- Rouge (attendu) :
  - `make gateway-exposure-v2-negative`

Voir aussi : `docs/gateway-exposure-matrix.md` dans le depot des modeles.

### Pipeline Nodes.run (capacite a plus haut risque)

**Affirmation :** `nodes.run` requiert (a) une liste blanche de commandes de nœud plus des commandes declarees et (b) une approbation en temps reel lorsqu’elle est configuree ; les approbations sont tokenisees pour empecher la relecture (dans le modele).

- Executions vertes :
  - `make nodes-pipeline`
  - `make approvals-token`
- Rouge (attendu) :
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### Magasin d’appairage (filtrage des Messages prives)

**Affirmation :** les demandes d’appairage respectent le TTL et les plafonds de demandes en attente.

- Executions vertes :
  - `make pairing`
  - `make pairing-cap`
- Rouge (attendu) :
  - `make pairing-negative`
  - `make pairing-cap-negative`

### Filtrage a l’entree (mentions + contournement par commande de controle)

**Affirmation :** dans les contextes de groupe exigeant une mention, une « commande de controle » non autorisee ne peut pas contourner le filtrage par mention.

- Vert :
  - `make ingress-gating`
- Rouge (attendu) :
  - `make ingress-gating-negative`

### Isolation du routage / des cles de session

**Affirmation :** les Messages prives provenant de pairs distincts ne se regroupent pas dans la meme session sauf s’ils sont explicitement lies/configures.

- Vert :
  - `make routing-isolation`
- Rouge (attendu) :
  - `make routing-isolation-negative`

## v1++ : modeles bornes supplementaires (concurrence, reprises, exactitude des traces)

Il s’agit de modeles de suivi qui renforcent la fidelite face aux modes de defaillance du monde reel (mises a jour non atomiques, reprises et diffusion de messages).

### Concurrence / idempotence du magasin d’appairage

**Affirmation :** un magasin d’appairage doit appliquer `MaxPending` et l’idempotence meme sous entrelacements (c.-a-d. « verifier puis ecrire » doit etre atomique / verrouille ; l’actualisation ne doit pas creer de doublons).

Ce que cela signifie :

- Sous des requetes concurrentes, vous ne pouvez pas depasser `MaxPending` pour un canal.
- Des requetes/actualisations repetees pour le meme `(channel, sender)` ne doivent pas creer de lignes en attente en double.

- Executions vertes :
  - `make pairing-race` (verification du plafond atomique/verrouillee)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- Rouge (attendu) :
  - `make pairing-race-negative` (course au plafond avec debut/commit non atomiques)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### Correlation des traces a l’ingestion / idempotence

**Affirmation :** l’ingestion doit preserver la correlation des traces lors de la diffusion et etre idempotente sous les reprises du fournisseur.

Ce que cela signifie :

- Lorsqu’un evenement externe devient plusieurs messages internes, chaque partie conserve la meme identite de trace/evenement.
- Les reprises n’entrainent pas de double traitement.
- Si les ID d’evenement du fournisseur sont absents, la deduplication se replie sur une cle sure (p. ex., l’ID de trace) afin d’eviter de supprimer des evenements distincts.

- Vert :
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- Rouge (attendu) :
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### Precedence dmScope du routage + identityLinks

**Affirmation :** le routage doit garder les sessions de Messages prives isolees par defaut, et ne regrouper les sessions que lorsqu’il est explicitement configure (priorite par canal + identityLinks).

Ce que cela signifie :

- Les remplacements dmScope specifiques au canal doivent prevaloir sur les valeurs par defaut globales.
- Les identityLinks ne doivent regrouper qu’au sein de groupes explicitement lies, pas entre pairs sans rapport.

- Vert :
  - `make routing-precedence`
  - `make routing-identitylinks`
- Rouge (attendu) :
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
