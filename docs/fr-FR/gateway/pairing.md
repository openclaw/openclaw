---
summary: "Appairage de nœud appartenant à la Passerelle (Option B) pour iOS et autres nœuds distants"
read_when:
  - Implémentation d'approbations d'appairage de nœud sans UI macOS
  - Ajout de flux CLI pour approuver des nœuds distants
  - Extension du protocole passerelle avec gestion de nœud
title: "Appairage appartenant à la Passerelle"
---

# Appairage appartenant à la Passerelle (Option B)

Dans l'appairage appartenant à la Passerelle, la **Passerelle** est la source de vérité pour quels nœuds sont autorisés à rejoindre. Les UI (app macOS, clients futurs) sont juste des frontends qui approuvent ou rejettent les demandes en attente.

**Important :** Les nœuds WS utilisent **l'appairage d'appareil** (rôle `node`) pendant `connect`. `node.pair.*` est un magasin d'appairage séparé et ne **contrôle pas** le handshake WS. Seuls les clients qui appellent explicitement `node.pair.*` utilisent ce flux.

## Concepts

- **Demande en attente** : un nœud a demandé à rejoindre ; nécessite approbation.
- **Nœud apparié** : nœud approuvé avec un token auth émis.
- **Transport** : le point de terminaison WS Passerelle transfère les demandes mais ne décide pas de l'appartenance. (Le support bridge TCP hérité est déprécié/supprimé.)

## Comment fonctionne l'appairage

1. Un nœud se connecte au WS Passerelle et demande l'appairage.
2. La Passerelle stocke une **demande en attente** et émet `node.pair.requested`.
3. Vous approuvez ou rejetez la demande (CLI ou UI).
4. Lors de l'approbation, la Passerelle émet un **nouveau token** (les tokens sont rotés lors du ré-appairage).
5. Le nœud se reconnecte en utilisant le token et est maintenant "apparié".

Les demandes en attente expirent automatiquement après **5 minutes**.

## Workflow CLI (convivial headless)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` affiche les nœuds appariés/connectés et leurs capacités.

## Surface API (protocole passerelle)

Événements :

- `node.pair.requested` — émis lorsqu'une nouvelle demande en attente est créée.
- `node.pair.resolved` — émis lorsqu'une demande est approuvée/rejetée/expirée.

Méthodes :

- `node.pair.request` — créer ou réutiliser une demande en attente.
- `node.pair.list` — lister les nœuds en attente + appariés.
- `node.pair.approve` — approuver une demande en attente (émet le token).
- `node.pair.reject` — rejeter une demande en attente.
- `node.pair.verify` — vérifier `{ nodeId, token }`.

Notes :

- `node.pair.request` est idempotent par nœud : les appels répétés retournent la même demande en attente.
- L'approbation génère **toujours** un nouveau token ; aucun token n'est jamais retourné depuis `node.pair.request`.
- Les demandes peuvent inclure `silent: true` comme indice pour les flux d'auto-approbation.

## Auto-approbation (app macOS)

L'app macOS peut optionnellement tenter une **approbation silencieuse** lorsque :

- la demande est marquée `silent`, et
- l'app peut vérifier une connexion SSH à l'hôte passerelle en utilisant le même utilisateur.

Si l'approbation silencieuse échoue, elle revient à l'invite normale "Approuver/Rejeter".

## Stockage (local, privé)

L'état d'appairage est stocké sous le répertoire d'état Passerelle (défaut `~/.openclaw`) :

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

Si vous remplacez `OPENCLAW_STATE_DIR`, le dossier `nodes/` se déplace avec lui.

Notes de sécurité :

- Les tokens sont des secrets ; traitez `paired.json` comme sensible.
- Roter un token nécessite une ré-approbation (ou supprimer l'entrée de nœud).

## Comportement du transport

- Le transport est **sans état** ; il ne stocke pas l'appartenance.
- Si la Passerelle est hors ligne ou l'appairage est désactivé, les nœuds ne peuvent pas s'appairer.
- Si la Passerelle est en mode distant, l'appairage se produit toujours contre le magasin de la Passerelle distante.
