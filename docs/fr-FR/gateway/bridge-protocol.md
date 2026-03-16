---
summary: "Protocole Bridge (nœuds hérités) : TCP JSONL, appairage, RPC scopé"
read_when:
  - Construction ou débogage de clients nœud (iOS/Android/mode nœud macOS)
  - Investigation d'échecs d'appairage ou d'auth bridge
  - Audit de la surface nœud exposée par la passerelle
title: "Protocole Bridge"
---

# Protocole Bridge (transport nœud hérité)

Le protocole Bridge est un transport nœud **hérité** (TCP JSONL). Les nouveaux clients nœud devraient utiliser le protocole WebSocket Passerelle unifié à la place.

Si vous construisez un opérateur ou un client nœud, utilisez le [Protocole passerelle](/fr-FR/gateway/protocol).

**Note :** Les builds OpenClaw actuels n'incluent plus l'écouteur bridge TCP ; ce document est conservé pour référence historique. Les clés de config héritées `bridge.*` ne font plus partie du schéma de config.

## Pourquoi nous avons les deux

- **Frontière de sécurité** : le bridge expose une petite liste autorisée au lieu de la surface API passerelle complète.
- **Appairage + identité nœud** : l'admission de nœud appartient à la passerelle et est liée à un token par nœud.
- **UX de découverte** : les nœuds peuvent découvrir les passerelles via Bonjour sur LAN, ou se connecter directement via un tailnet.
- **WS loopback** : le plan de contrôle WS complet reste local sauf s'il est tunnelisé via SSH.

## Transport

- TCP, un objet JSON par ligne (JSONL).
- TLS optionnel (quand `bridge.tls.enabled` est vrai).
- Le port d'écoute par défaut hérité était `18790` (les builds actuels ne démarrent pas de bridge TCP).

Lorsque TLS est activé, les enregistrements TXT de découverte incluent `bridgeTls=1` plus `bridgeTlsSha256` comme indice non-secret. Notez que les enregistrements TXT Bonjour/mDNS ne sont pas authentifiés ; les clients ne doivent pas traiter l'empreinte annoncée comme un épinglage autoritaire sans intention explicite de l'utilisateur ou autre vérification hors bande.

## Handshake + appairage

1. Le client envoie `hello` avec les métadonnées nœud + token (si déjà apparié).
2. Si non apparié, la passerelle répond `error` (`NOT_PAIRED`/`UNAUTHORIZED`).
3. Le client envoie `pair-request`.
4. La passerelle attend l'approbation, puis envoie `pair-ok` et `hello-ok`.

`hello-ok` retourne `serverName` et peut inclure `canvasHostUrl`.

## Trames

Client → Passerelle :

- `req` / `res` : RPC passerelle scopé (chat, sessions, config, health, voicewake, skills.bins)
- `event` : signaux nœud (transcription vocale, requête agent, abonnement chat, cycle de vie exec)

Passerelle → Client :

- `invoke` / `invoke-res` : commandes nœud (`canvas.*`, `camera.*`, `screen.record`, `location.get`, `sms.send`)
- `event` : mises à jour de chat pour les sessions abonnées
- `ping` / `pong` : maintien en vie

L'application de la liste autorisée héritée vivait dans `src/gateway/server-bridge.ts` (supprimé).

## Événements de cycle de vie exec

Les nœuds peuvent émettre des événements `exec.finished` ou `exec.denied` pour exposer l'activité system.run. Ceux-ci sont mappés aux événements système dans la passerelle. (Les nœuds hérités peuvent toujours émettre `exec.started`.)

Champs de charge utile (tous optionnels sauf indication) :

- `sessionKey` (requis) : session agent pour recevoir l'événement système.
- `runId` : id exec unique pour le regroupement.
- `command` : chaîne de commande brute ou formatée.
- `exitCode`, `timedOut`, `success`, `output` : détails de complétion (finished uniquement).
- `reason` : raison du refus (denied uniquement).

## Usage Tailnet

- Liez le bridge à une IP tailnet : `bridge.bind: "tailnet"` dans `~/.openclaw/openclaw.json`.
- Les clients se connectent via le nom MagicDNS ou l'IP tailnet.
- Bonjour ne **traverse pas** les réseaux ; utilisez l'hôte/port manuel ou DNS‑SD à grande échelle si nécessaire.

## Versionnage

Bridge est actuellement **v1 implicite** (pas de négociation min/max). La rétrocompatibilité est attendue ; ajoutez un champ de version de protocole bridge avant tout changement cassant.
