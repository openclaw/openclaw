---
summary: "Comment les entrées de présence d'OpenClaw sont produites, fusionnées et affichées"
read_when:
  - Déboguer l'onglet Instances
  - Enquêter sur les lignes d'instance dupliquées ou obsolètes
  - Changer la connexion WS de passerelle ou les balises d'événement système
title: "Présence"
---

# Présence

La "présence" d'OpenClaw est une vue légère, au mieux de l'effort de :

- la **Passerelle** elle-même, et
- les **clients connectés à la Passerelle** (app mac, WebChat, CLI, etc.)

La présence est utilisée principalement pour rendre l'onglet **Instances** de l'app macOS et pour
fournir une visibilité rapide à l'opérateur.

## Champs de présence (ce qui s'affiche)

Les entrées de présence sont des objets structurés avec des champs comme :

- `instanceId` (optionnel mais fortement recommandé) : identité client stable (généralement `connect.client.instanceId`)
- `host` : nom d'hôte convivial
- `ip` : adresse IP au mieux de l'effort
- `version` : chaîne de version du client
- `deviceFamily` / `modelIdentifier` : indices matériels
- `mode` : `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds` : "secondes depuis la dernière saisie utilisateur" (si connue)
- `reason` : `self`, `connect`, `node-connected`, `periodic`, ...
- `ts` : timestamp de dernière mise à jour (ms depuis l'époque)

## Producteurs (d'où vient la présence)

Les entrées de présence sont produites par plusieurs sources et **fusionnées**.

### 1) Entrée auto de passerelle

La Passerelle ensemence toujours une entrée "self" au démarrage donc les UIs montrent l'hôte de passerelle
même avant que des clients ne se connectent.

### 2) Connexion WebSocket

Chaque client WS commence par une requête `connect`. Lors du handshake réussi la
Passerelle upsert une entrée de présence pour cette connexion.

#### Pourquoi les commandes CLI uniques n'apparaissent pas

La CLI se connecte souvent pour des commandes courtes, uniques. Pour éviter de spammer la
liste Instances, `client.mode === "cli"` n'est **pas** transformé en entrée de présence.

### 3) Balises `system-event`

Les clients peuvent envoyer des balises périodiques plus riches via la méthode `system-event`. L'app mac
utilise ceci pour reporter le nom d'hôte, l'IP et `lastInputSeconds`.

### 4) Connexions de nœud (role: node)

Quand un nœud se connecte via le WebSocket de Passerelle avec `role: node`, la Passerelle
upsert une entrée de présence pour ce nœud (même flux que les autres clients WS).

## Règles de fusion + dédupe (pourquoi `instanceId` compte)

Les entrées de présence sont stockées dans une seule carte en mémoire :

- Les entrées sont indexées par une **clé de présence**.
- La meilleure clé est un `instanceId` stable (de `connect.client.instanceId`) qui survit aux redémarrages.
- Les clés sont insensibles à la casse.

Si un client se reconnecte sans `instanceId` stable, il peut apparaître comme une
ligne **dupliquée**.

## TTL et taille bornée

La présence est intentionnellement éphémère :

- **TTL :** les entrées plus anciennes que 5 minutes sont élaguées
- **Entrées max :** 200 (les plus anciennes abandonnées en premier)

Cela garde la liste fraîche et évite la croissance mémoire non bornée.

## Avertissement distant/tunnel (IPs loopback)

Quand un client se connecte via un tunnel SSH / transfert de port local, la Passerelle peut
voir l'adresse distante comme `127.0.0.1`. Pour éviter d'écraser une bonne IP reportée par client,
les adresses distantes loopback sont ignorées.

## Consommateurs

### Onglet Instances macOS

L'app macOS rend la sortie de `system-presence` et applique un petit indicateur de statut
(Actif/Inactif/Obsolète) basé sur l'âge de la dernière mise à jour.

## Conseils de débogage

- Pour voir la liste brute, appelez `system-presence` contre la Passerelle.
- Si vous voyez des doublons :
  - confirmez que les clients envoient un `client.instanceId` stable dans le handshake
  - confirmez que les balises périodiques utilisent le même `instanceId`
  - vérifiez si l'entrée dérivée de connexion manque `instanceId` (des doublons sont attendus)
