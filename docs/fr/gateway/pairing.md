---
summary: "Appariement des nœuds détenu par la Gateway (Option B) pour iOS et autres nœuds distants"
read_when:
  - Mise en œuvre des approbations d’appariement de nœuds sans interface macOS
  - Ajout de flux CLI pour approuver des nœuds distants
  - Extension du protocole de la Gateway avec la gestion des nœuds
title: "Appariement détenu par la Gateway"
---

# Appariement détenu par la Gateway (Option B)

Dans l’appariement détenu par la **Gateway**, la **Gateway** est la source de vérité concernant les nœuds autorisés à rejoindre. Les interfaces (application macOS, futurs clients) ne sont que des frontends qui approuvent ou rejettent les demandes en attente.

**Important :** les nœuds WS utilisent l’**appariement de l’appareil** (rôle `node`) pendant `connect`.
`node.pair.*` est un magasin d’appariement distinct et ne **contrôle pas** l’établissement de la connexion WS.
Seuls les clients qui appellent explicitement `node.pair.*` utilisent ce flux.

## Concepts

- **Demande en attente** : un nœud a demandé à rejoindre ; une approbation est requise.
- **Nœud apparié** : nœud approuvé avec un jeton d’authentification émis.
- **Transport** : le point de terminaison WS de la Gateway relaie les requêtes mais ne décide pas de l’appartenance. (La prise en charge héritée du pont TCP est obsolète/supprimée.)

## Comment fonctionne le jumelage

1. Un nœud se connecte au WS de la Gateway et demande l’appariement.
2. La Gateway enregistre une **demande en attente** et émet `node.pair.requested`.
3. Vous approuvez ou rejetez la demande (CLI ou UI).
4. En cas d’approbation, la Gateway émet un **nouveau jeton** (les jetons sont renouvelés lors d’un ré‑appariement).
5. Le nœud se reconnecte en utilisant le jeton et est désormais « apparié ».

Les demandes en attente expirent automatiquement après **5 minutes**.

## Flux CLI (adapté au headless)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` affiche les nœuds appariés/connectés et leurs capacités.

## Surface API (protocole de la Gateway)

Événements :

- `node.pair.requested` — émis lorsqu’une nouvelle demande en attente est créée.
- `node.pair.resolved` — émis lorsqu’une demande est approuvée/rejetée/expirée.

Méthodes :

- `node.pair.request` — créer ou réutiliser une demande en attente.
- `node.pair.list` — lister les nœuds en attente + appariés.
- `node.pair.approve` — approuver une demande en attente (émet un jeton).
- `node.pair.reject` — rejeter une demande en attente.
- `node.pair.verify` — vérifier `{ nodeId, token }`.

Notes :

- `node.pair.request` est idempotent par nœud : les appels répétés renvoient la même demande en attente.
- L’approbation génère **toujours** un jeton neuf ; aucun jeton n’est jamais renvoyé par `node.pair.request`.
- Les demandes peuvent inclure `silent: true` comme indication pour des flux d’auto‑approbation.

## Auto‑approbation (application macOS)

L’application macOS peut, de manière optionnelle, tenter une **approbation silencieuse** lorsque :

- la demande est marquée `silent`, et
- l’application peut vérifier une connexion SSH à l’hôte de la Gateway en utilisant le même utilisateur.

Si l’approbation silencieuse échoue, elle revient à l’invite normale « Approuver/Rejeter ».

## Stockage (local, privé)

L’état d’appariement est stocké sous le répertoire d’état de la Gateway (par défaut `~/.openclaw`) :

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

Si vous remplacez `OPENCLAW_STATE_DIR`, le dossier `nodes/` se déplace avec celui‑ci.

Notes de sécurité :

- Les jetons sont des secrets ; traitez `paired.json` comme sensible.
- La rotation d’un jeton nécessite une ré‑approbation (ou la suppression de l’entrée du nœud).

## Comportement du transport

- Le transport est **sans état** ; il ne stocke pas l’appartenance.
- Si la Gateway est hors ligne ou si l’appariement est désactivé, les nœuds ne peuvent pas s’apparier.
- Si la Gateway est en mode distant, l’appariement s’effectue toujours par rapport au magasin de la Gateway distante.
