---
title: Vérification formelle (modèles de sécurité)
summary: Modèles de sécurité vérifiés par machine pour les parcours à plus haut risque d’OpenClaw.
permalink: /security/formal-verification/
x-i18n:
  source_path: gateway/security/formal-verification.md
  source_hash: 8dff6ea41a37fb6b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:01:53Z
---

# Vérification formelle (modèles de sécurité)

Cette page recense les **modèles de sécurité formels** d’OpenClaw (TLA+/TLC aujourd’hui ; d’autres au besoin).

> Remarque : certains liens plus anciens peuvent faire référence à l’ancien nom du projet.

**Objectif (étoile polaire) :** fournir un argument vérifié par machine démontrant qu’OpenClaw applique sa
politique de sécurité prévue (autorisation, isolation des sessions, filtrage des outils et
sécurité face aux erreurs de configuration), sous des hypothèses explicites.

**Ce que c’est (aujourd’hui) :** une **suite de régression de sécurité** exécutable, pilotée par l’attaquant :

- Chaque affirmation dispose d’une vérification par model-checking exécutable sur un espace d’états fini.
- De nombreuses affirmations ont un **modèle négatif** apparié qui produit une trace de contre-exemple pour une classe de bogues réaliste.

**Ce que ce n’est pas (encore) :** une preuve que « OpenClaw est sécurisé à tous égards » ni que l’implémentation TypeScript complète est correcte.

## Où vivent les modèles

Les modèles sont maintenus dans un dépôt séparé : [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models).

## Avertissements importants

- Il s’agit de **modèles**, pas de l’implémentation TypeScript complète. Un écart entre le modèle et le code est possible.
- Les résultats sont bornés par l’espace d’états exploré par TLC ; un statut « vert » n’implique pas une sécurité au-delà des hypothèses et bornes modélisées.
- Certaines affirmations reposent sur des hypothèses environnementales explicites (p. ex., déploiement correct, entrées de configuration correctes).

## Reproduire les résultats

Aujourd’hui, les résultats sont reproduits en clonant localement le dépôt des modèles et en exécutant TLC (voir ci-dessous). Une itération future pourrait proposer :

- des modèles exécutés en CI avec des artefacts publics (traces de contre-exemples, journaux d’exécution) ;
- un flux de travail hébergé « exécuter ce modèle » pour des vérifications petites et bornées.

Premiers pas :

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.

make <target>
```

### Exposition de la Gateway (passerelle) et mauvaise configuration d’une gateway ouverte

**Affirmation :** un bind au-delà du local loopback sans authentification peut rendre une compromission distante possible / augmente l’exposition ; un jeton/mot de passe bloque les attaquants non authentifiés (selon les hypothèses du modèle).

- Exécutions vertes :
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- Rouge (attendu) :
  - `make gateway-exposure-v2-negative`

Voir aussi : `docs/gateway-exposure-matrix.md` dans le dépôt des modèles.

### Pipeline Nodes.run (capacité à plus haut risque)

**Affirmation :** `nodes.run` exige (a) une liste blanche des commandes du nœud plus des commandes déclarées et (b) une approbation en direct lorsqu’elle est configurée ; les approbations sont tokenisées pour empêcher la relecture (dans le modèle).

- Exécutions vertes :
  - `make nodes-pipeline`
  - `make approvals-token`
- Rouge (attendu) :
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### Magasin d’appairage (filtrage des Messages privés)

**Affirmation :** les demandes d’appairage respectent le TTL et les plafonds de demandes en attente.

- Exécutions vertes :
  - `make pairing`
  - `make pairing-cap`
- Rouge (attendu) :
  - `make pairing-negative`
  - `make pairing-cap-negative`

### Filtrage d’ingress (mentions + contournement des commandes de contrôle)

**Affirmation :** dans des contextes de groupe nécessitant une mention, une « commande de contrôle » non autorisée ne peut pas contourner le filtrage par mention.

- Vert :
  - `make ingress-gating`
- Rouge (attendu) :
  - `make ingress-gating-negative`

### Routage / isolation par clé de session

**Affirmation :** des Messages privés provenant de pairs distincts ne se retrouvent pas dans la même session, sauf s’ils sont explicitement liés/configurés.

- Vert :
  - `make routing-isolation`
- Rouge (attendu) :
  - `make routing-isolation-negative`

## v1++ : modèles bornés supplémentaires (concurrence, retries, exactitude des traces)

Il s’agit de modèles de suivi qui renforcent la fidélité face aux modes de défaillance du monde réel (mises à jour non atomiques, retries et diffusion de messages).

### Concurrence / idempotence du magasin d’appairage

**Affirmation :** un magasin d’appairage doit appliquer `MaxPending` et l’idempotence même sous des entrelacements (c.-à-d., « vérifier puis écrire » doit être atomique / verrouillé ; un rafraîchissement ne doit pas créer de doublons).

Ce que cela signifie :

- Sous des requêtes concurrentes, vous ne pouvez pas dépasser `MaxPending` pour un canal.
- Des requêtes/rafraîchissements répétés pour le même `(channel, sender)` ne doivent pas créer de lignes en attente actives dupliquées.

- Exécutions vertes :
  - `make pairing-race` (vérification du plafond atomique/verrouillée)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- Rouge (attendu) :
  - `make pairing-race-negative` (course plafond begin/commit non atomique)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### Corrélation des traces d’ingress / idempotence

**Affirmation :** l’ingestion doit préserver la corrélation des traces lors de la diffusion et être idempotente sous les retries du fournisseur.

Ce que cela signifie :

- Lorsqu’un événement externe devient plusieurs messages internes, chaque partie conserve la même identité de trace/événement.
- Les retries n’entraînent pas de double traitement.
- Si les identifiants d’événements du fournisseur sont absents, la déduplication se rabat sur une clé sûre (p. ex., l’ID de trace) afin d’éviter de supprimer des événements distincts.

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

### Routage : précédence dmScope + identityLinks

**Affirmation :** le routage doit maintenir l’isolation des sessions de Messages privés par défaut, et ne regrouper les sessions que lorsqu’il est explicitement configuré (précédence de canal + identity links).

Ce que cela signifie :

- Les remplacements dmScope spécifiques au canal doivent prévaloir sur les valeurs par défaut globales.
- Les identityLinks ne doivent regrouper que des groupes explicitement liés, et non des pairs non liés.

- Vert :
  - `make routing-precedence`
  - `make routing-identitylinks`
- Rouge (attendu) :
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
