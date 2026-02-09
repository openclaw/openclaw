---
summary: "Protocole de pont (nœuds hérités) : TCP JSONL, appairage, RPC à portée limitée"
read_when:
  - Création ou débogage de clients nœuds (mode nœud iOS/Android/macOS)
  - Investigation des échecs d’appairage ou d’authentification du pont
  - Audit de la surface nœud exposée par la passerelle
title: "Protocole de pont"
---

# Protocole de pont (transport de nœud hérité)

Le protocole de pont est un transport de nœud **hérité** (TCP JSONL). Les nouveaux clients nœuds
doivent utiliser à la place le protocole WebSocket unifié de la Gateway (passerelle).

Si vous développez un opérateur ou un client nœud, utilisez le
[protocole Gateway](/gateway/protocol).

**Remarque :** Les versions actuelles d’OpenClaw n’intègrent plus l’écouteur TCP du pont ; ce document est conservé à des fins de référence historique.
Les clés de configuration héritées `bridge.*` ne font plus partie du schéma de configuration.

## Pourquoi nous avons les deux

- **Frontière de sécurité** : le pont expose une petite liste d’autorisations plutôt que
  l’ensemble de la surface de l’API de la Gateway.
- **Appairage + identité du nœud** : l’admission des nœuds est gérée par la Gateway et liée
  à un jeton par nœud.
- **UX de découverte** : les nœuds peuvent découvrir les passerelles via Bonjour sur le LAN,
  ou se connecter directement via un tailnet.
- **WS en loopback** : le plan de contrôle WS complet reste local sauf s’il est tunnelisé via SSH.

## Transport

- TCP, un objet JSON par ligne (JSONL).
- TLS optionnel (lorsque `bridge.tls.enabled` est vrai).
- Le port d’écoute hérité par défaut était `18790` (les versions actuelles ne démarrent pas de pont TCP).

Lorsque TLS est activé, les enregistrements TXT de découverte incluent `bridgeTls=1` plus
`bridgeTlsSha256` afin que les nœuds puissent épingler le certificat.

## Handshake + appairage

1. Le client envoie `hello` avec les métadonnées du nœud + le jeton (s’il est déjà appairé).
2. S’il n’est pas appairé, la Gateway répond `error` (`NOT_PAIRED`/`UNAUTHORIZED`).
3. Le client envoie `pair-request`.
4. La Gateway attend l’approbation, puis envoie `pair-ok` et `hello-ok`.

`hello-ok` renvoie `serverName` et peut inclure `canvasHostUrl`.

## Frames

Client → Gateway :

- `req` / `res` : RPC Gateway à portée limitée (chat, sessions, config, health, voicewake, skills.bins)
- `event` : signaux du nœud (transcription vocale, requête d’agent, abonnement au chat, cycle de vie exec)

Gateway → Client :

- `invoke` / `invoke-res` : commandes du nœud (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event` : mises à jour de chat pour les sessions abonnées
- `ping` / `pong` : keepalive

L’application de la liste d’autorisations héritée se trouvait dans `src/gateway/server-bridge.ts` (supprimé).

## Événements du cycle de vie exec

Les nœuds peuvent émettre des événements `exec.finished` ou `exec.denied` pour exposer l’activité system.run.
Ils sont mappés vers des événements système dans la Gateway. (Les nœuds hérités peuvent encore émettre `exec.started`.)

Champs de charge utile (tous optionnels sauf indication contraire) :

- `sessionKey` (requis) : session d’agent qui reçoit l’événement système.
- `runId` : identifiant exec unique pour le regroupement.
- `command` : chaîne de commande brute ou formatée.
- `exitCode`, `timedOut`, `success`, `output` : détails d’achèvement (terminé uniquement).
- `reason` : raison du refus (refusé uniquement).

## Utilisation du tailnet

- Lier le pont à une IP de tailnet : `bridge.bind: "tailnet"` dans
  `~/.openclaw/openclaw.json`.
- Les clients se connectent via un nom MagicDNS ou une IP de tailnet.
- Bonjour **ne** traverse pas les réseaux ; utilisez un hôte/port manuel ou un DNS‑SD étendu
  si nécessaire.

## Versioning

Le pont est actuellement en **v1 implicite** (pas de négociation min/max). La rétro‑compatibilité
est attendue ; ajoutez un champ de version du protocole de pont avant toute modification incompatible.
