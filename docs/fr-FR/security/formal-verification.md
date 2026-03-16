---
title: Vérification formelle (modèles de sécurité)
summary: Modèles de sécurité vérifiés par machine pour les chemins les plus à risque d'OpenClaw.
permalink: /fr-FR/security/formal-verification/
---

# Vérification formelle (modèles de sécurité)

Cette page suit les **modèles de sécurité formels** d'OpenClaw (TLA+/TLC aujourd'hui ; plus selon les besoins).

> Note : certains liens plus anciens peuvent faire référence à l'ancien nom du projet.

**Objectif (étoile du nord) :** fournir un argument vérifié par machine qu'OpenClaw applique sa
politique de sécurité prévue (autorisation, isolation de session, gating d'outils, et
sécurité contre la mauvaise configuration), sous des hypothèses explicites.

**Ce que c'est (aujourd'hui) :** une **suite de régression de sécurité** exécutable, pilotée par l'attaquant :

- Chaque affirmation a une vérification de modèle exécutable sur un espace d'états fini.
- Beaucoup d'affirmations ont un **modèle négatif** associé qui produit une trace de contre-exemple pour une classe de bugs réaliste.

**Ce que ce n'est pas (encore) :** une preuve que "OpenClaw est sécurisé sous tous aspects" ou que l'implémentation TypeScript complète est correcte.

## Où vivent les modèles

Les modèles sont maintenus dans un dépôt séparé : [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models).

## Mises en garde importantes

- Ce sont des **modèles**, pas l'implémentation TypeScript complète. Une dérive entre modèle et code est possible.
- Les résultats sont bornés par l'espace d'états exploré par TLC ; "vert" n'implique pas la sécurité au-delà des hypothèses modélisées et des limites.
- Certaines affirmations reposent sur des hypothèses environnementales explicites (ex., déploiement correct, entrées de configuration correctes).

## Reproduire les résultats

Aujourd'hui, les résultats sont reproduits en clonant le dépôt des modèles localement et en exécutant TLC (voir ci-dessous). Une future itération pourrait offrir :

- Modèles exécutés en CI avec artefacts publics (traces de contre-exemples, journaux d'exécution)
- Un workflow hébergé "exécuter ce modèle" pour de petites vérifications bornées

Démarrage :

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ requis (TLC s'exécute sur la JVM).
# Le dépôt fournit un `tla2tools.jar` épinglé (outils TLA+) et propose `bin/tlc` + cibles Make.

make <target>
```

### Exposition de passerelle et mauvaise configuration de passerelle ouverte

**Affirmation :** lier au-delà de loopback sans authentification peut rendre possible un compromis distant / augmente l'exposition ; token/mot de passe bloque les attaquants non authentifiés (selon les hypothèses du modèle).

- Exécutions vertes :
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- Rouge (attendu) :
  - `make gateway-exposure-v2-negative`

Voir aussi : `docs/gateway-exposure-matrix.md` dans le dépôt des modèles.

### Pipeline nodes.run (capacité la plus à risque)

**Affirmation :** `nodes.run` nécessite (a) liste blanche de commandes de nœud plus commandes déclarées et (b) approbation en direct quand configurée ; les approbations sont tokenisées pour empêcher la relecture (dans le modèle).

- Exécutions vertes :
  - `make nodes-pipeline`
  - `make approvals-token`
- Rouge (attendu) :
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### Magasin d'appairage (gating DM)

**Affirmation :** les requêtes d'appairage respectent le TTL et les limites de requêtes en attente.

- Exécutions vertes :
  - `make pairing`
  - `make pairing-cap`
- Rouge (attendu) :
  - `make pairing-negative`
  - `make pairing-cap-negative`

### Gating d'ingress (mentions + contournement de commande de contrôle)

**Affirmation :** dans les contextes de groupe nécessitant une mention, une "commande de contrôle" non autorisée ne peut pas contourner le gating de mention.

- Vert :
  - `make ingress-gating`
- Rouge (attendu) :
  - `make ingress-gating-negative`

### Isolation de routage/clé de session

**Affirmation :** les DMs de pairs distincts ne s'effondrent pas dans la même session sauf si explicitement liés/configurés.

- Vert :
  - `make routing-isolation`
- Rouge (attendu) :
  - `make routing-isolation-negative`

## v1++ : modèles bornés supplémentaires (concurrence, réessais, exactitude des traces)

Ce sont des modèles de suivi qui resserrent la fidélité autour des modes de défaillance du monde réel (mises à jour non atomiques, réessais, et fan-out de messages).

### Concurrence / idempotence du magasin d'appairage

**Affirmation :** un magasin d'appairage devrait appliquer `MaxPending` et l'idempotence même sous entrelacement (c'est-à-dire, "check-then-write" doit être atomique / verrouillé ; refresh ne devrait pas créer de doublons).

Ce que cela signifie :

- Sous requêtes concurrentes, vous ne pouvez pas dépasser `MaxPending` pour un canal.
- Les requêtes/refreshes répétés pour le même `(channel, sender)` ne devraient pas créer de lignes en attente en double.

- Exécutions vertes :
  - `make pairing-race` (vérification de cap atomique/verrouillée)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- Rouge (attendu) :
  - `make pairing-race-negative` (race de cap begin/commit non atomique)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### Corrélation de trace d'ingress / idempotence

**Affirmation :** l'ingestion devrait préserver la corrélation de trace à travers le fan-out et être idempotente sous réessais de fournisseur.

Ce que cela signifie :

- Quand un événement externe devient plusieurs messages internes, chaque partie garde la même identité de trace/événement.
- Les réessais ne résultent pas en double traitement.
- Si les IDs d'événement de fournisseur sont manquants, dedupe replie vers une clé sûre (ex., ID de trace) pour éviter de laisser tomber des événements distincts.

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

### Précédence dmScope de routage + identityLinks

**Affirmation :** le routage doit garder les sessions DM isolées par défaut, et effondrer les sessions uniquement quand explicitement configuré (précédence de canal + liens d'identité).

Ce que cela signifie :

- Les remplacements dmScope spécifiques au canal doivent gagner sur les défauts globaux.
- identityLinks devrait effondrer uniquement dans des groupes liés explicites, pas à travers des pairs non liés.

- Vert :
  - `make routing-precedence`
  - `make routing-identitylinks`
- Rouge (attendu) :
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
