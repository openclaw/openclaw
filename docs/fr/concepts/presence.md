---
summary: "Comment les entrées de présence OpenClaw sont produites, fusionnées et affichées"
read_when:
  - Débogage de l’onglet Instances
  - Investigation de lignes d’instance en double ou obsolètes
  - Modification de la connexion WS de la Gateway ou des balises d’événements système
title: "Présence"
---

# Présence

La « présence » OpenClaw est une vue légère, au mieux des efforts, de :

- la **Gateway** elle‑même, et
- les **clients connectés à la Gateway** (application mac, WebChat, CLI, etc.)

La présence est principalement utilisée pour afficher l’onglet **Instances** de
l’application macOS et fournir une visibilité rapide aux opérateurs.

## Champs de présence (ce qui s’affiche)

Les entrées de présence sont des objets structurés avec des champs tels que :

- `instanceId` (facultatif mais fortement recommandé) : identité client stable (généralement `connect.client.instanceId`)
- `host` : nom d’hôte lisible par l’humain
- `ip` : adresse IP au mieux des efforts
- `version` : chaîne de version du client
- `deviceFamily` / `modelIdentifier` : indications matérielles
- `mode` : `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds` : « secondes depuis la dernière interaction utilisateur » (si connu)
- `reason` : `self`, `connect`, `node-connected`, `periodic`, ...
- `ts` : horodatage de la dernière mise à jour (ms depuis l’époque)

## Producteurs (origine de la présence)

Les entrées de présence sont produites par plusieurs sources et **fusionnées**.

### 1. Entrée propre à la Gateway

La Gateway initialise toujours une entrée « self » au démarrage afin que les
interfaces affichent l’hôte de la gateway même avant la connexion de clients.

### 2. Connexion WebSocket

Chaque client WS commence par une requête `connect`. Lors d’une poignée de
main réussie, la Gateway effectue un upsert d’une entrée de présence pour cette
connexion.

#### Pourquoi les commandes CLI ponctuelles n’apparaissent pas

La CLI se connecte souvent pour des commandes courtes et ponctuelles. Afin
d’éviter de polluer la liste Instances, `client.mode === "cli"` **n’est pas** transformé
en entrée de présence.

### 3. Balises `system-event`

Les clients peuvent envoyer des balises périodiques plus riches via la méthode
`system-event`. L’application mac l’utilise pour signaler le nom d’hôte, l’IP et
`lastInputSeconds`.

### 4. Connexions de nœud (rôle : node)

Lorsqu’un nœud se connecte via le WebSocket de la Gateway avec `role: node`, la
Gateway effectue un upsert d’une entrée de présence pour ce nœud (même flux que
pour les autres clients WS).

## Règles de fusion et de déduplication (pourquoi `instanceId` est important)

Les entrées de présence sont stockées dans une unique map en mémoire :

- Les entrées sont indexées par une **clé de présence**.
- La meilleure clé est un `instanceId` stable (issu de `connect.client.instanceId`) qui
  survit aux redémarrages.
- Les clés sont insensibles à la casse.

Si un client se reconnecte sans `instanceId` stable, il peut apparaître comme
une ligne **dupliquée**.

## TTL et taille bornée

La présence est volontairement éphémère :

- **TTL :** les entrées de plus de 5 minutes sont supprimées
- **Nombre maximal d’entrées :** 200 (les plus anciennes sont supprimées en premier)

Cela maintient la liste à jour et évite une croissance mémoire non bornée.

## Avertissement distant/tunnel (IP loopback)

Lorsqu’un client se connecte via un tunnel SSH / un transfert de port local, la
Gateway peut voir l’adresse distante comme `127.0.0.1`. Pour éviter
d’écraser une bonne IP signalée par le client, les adresses distantes loopback
sont ignorées.

## Consommateurs

### Onglet Instances macOS

L’application macOS affiche la sortie de `system-presence` et applique un petit
indicateur d’état (Actif/Inactif/Obsolète) en fonction de l’âge de la dernière
mise à jour.

## Conseils de débogage

- Pour voir la liste brute, appelez `system-presence` sur la Gateway.
- Si vous observez des doublons :
  - confirmez que les clients envoient un `client.instanceId` stable lors de la poignée de main
  - confirmez que les balises périodiques utilisent le même `instanceId`
  - vérifiez si l’entrée dérivée de la connexion est dépourvue de `instanceId` (les doublons sont attendus)
