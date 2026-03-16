---
summary: "Refactor Clawnet : unifier protocole réseau, rôles, auth, approbations, identité"
read_when:
  - Planification protocole réseau unifié pour nodes + clients operator
  - Refactorisation approbations, pairing, TLS et présence à travers devices
title: "Refactor Clawnet"
---

# Refactor Clawnet (unification protocole + auth)

## Salut

Salut Peter — excellente direction ; cela débloque UX plus simple + sécurité plus forte.

## Objectif

Document unique et rigoureux pour :

- État actuel : protocoles, flux, limites confiance.
- Points douloureux : approbations, routing multi-hop, duplication UI.
- Nouvel état proposé : un protocole, rôles scopés, auth/pairing unifiés, pinning TLS.
- Modèle identité : IDs stables + slugs cute.
- Plan migration, risques, questions ouvertes.

## Objectifs (depuis discussion)

- Un protocole pour tous clients (app mac, CLI, iOS, Android, node headless).
- Chaque participant réseau authentifié + apparié.
- Clarté rôle : nodes vs operators.
- Approbations centrales routées où user est.
- Encryption TLS + pinning optionnel pour tout trafic distant.
- Duplication code minimale.
- Machine unique devrait apparaître une fois (aucune entrée duplicate UI/node).

## Non-objectifs (explicites)

- Supprimer séparation capability (toujours besoin least-privilege).
- Exposer plan contrôle passerelle complet sans checks scope.
- Faire auth dépendre labels humains (slugs restent non-sécurité).

---

# État actuel (as-is)

## Deux protocoles

### 1) WebSocket Passerelle (plan contrôle)

- Surface API complète : config, canaux, modèles, sessions, runs agent, logs, nodes, etc.
- Bind défaut : loopback. Accès distant via SSH/Tailscale.
- Auth : token/password via `connect`.
- Aucun pinning TLS (repose sur loopback/tunnel).
- Code :
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2) Bridge (transport node)

- Surface allowlist étroite, identité node + pairing.
- JSONL sur TCP ; TLS optionnel + pinning fingerprint cert.
- TLS advertise fingerprint dans discovery TXT.
- Code :
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## Clients plan contrôle aujourd'hui

- CLI → Gateway WS via `callGateway` (`src/gateway/call.ts`).
- UI app macOS → Gateway WS (`GatewayConnection`).
- Web Control UI → Gateway WS.
- ACP → Gateway WS.
- Contrôle browser utilise propre serveur contrôle HTTP.

## Nodes aujourd'hui

- App macOS en mode node se connecte à bridge Passerelle (`MacNodeBridgeSession`).
- Apps iOS/Android se connectent à bridge Passerelle.
- Pairing + token per-node stockés sur passerelle.

## Flux approbation actuel (exec)

- Agent utilise `system.run` via Passerelle.
- Passerelle invoque node via bridge.
- Runtime node décide approbation.
- Prompt UI affiché par app mac (quand node == app mac).
- Node retourne `invoke-res` à Passerelle.
- Multi-hop, UI lié à node host.

## Présence + identité aujourd'hui

- Entrées présence passerelle depuis clients WS.
- Entrées présence node depuis bridge.
- App mac peut afficher deux entrées pour même machine (UI + node).
- Identité node stockée dans store pairing ; identité UI séparée.

---

# Problèmes / points douloureux

- Deux stacks protocole à maintenir (WS + Bridge).
- Approbations sur nodes distants : prompt apparaît sur node host, pas où user est.
- Pinning TLS existe seulement pour bridge ; WS dépend SSH/Tailscale.
- Duplication identité : même machine affiche comme instances multiples.
- Rôles ambigus : capabilities UI + node + CLI pas clairement séparées.

---

# Nouvel état proposé (Clawnet)

## Un protocole, deux rôles

Protocole WS unique avec rôle + scope.

- **Rôle : node** (host capability)
- **Rôle : operator** (plan contrôle)
- **Scope** optionnel pour operator :
  - `operator.read` (status + viewing)
  - `operator.write` (run agent, sends)
  - `operator.admin` (config, canaux, modèles)

### Comportements rôle

**Node**

- Peut enregistrer capabilities (`caps`, `commands`, permissions).
- Peut recevoir commandes `invoke` (`system.run`, `camera.*`, `canvas.*`, `screen.record`, etc).
- Peut envoyer événements : `voice.transcript`, `agent.request`, `chat.subscribe`.
- Ne peut pas appeler APIs plan contrôle config/models/channels/sessions/agent.

**Operator**

- API plan contrôle complète, gatée par scope.
- Reçoit toutes approbations.
- N'exécute pas directement actions OS ; route vers nodes.

### Règle clé

Rôle est per-connexion, pas per device. Device peut ouvrir deux rôles, séparément.

---

# Authentication + pairing unifiés

## Identité client

Chaque client fournit :

- `deviceId` (stable, dérivé depuis clé device).
- `displayName` (nom humain).
- `role` + `scope` + `caps` + `commands`.

## Flux pairing (unifié)

- Client se connecte non authentifié.
- Passerelle crée **requête pairing** pour ce `deviceId`.
- Operator reçoit prompt ; approuve/refuse.
- Passerelle émet credentials liées à :
  - clé publique device
  - rôle(s)
  - scope(s)
  - capabilities/commandes
- Client persiste token, reconnecte authentifié.

## Auth device-bound (éviter replay bearer token)

Préféré : keypairs device.

- Device génère keypair une fois.
- `deviceId = fingerprint(publicKey)`.
- Passerelle envoie nonce ; device signe ; passerelle vérifie.
- Tokens émis vers clé publique (proof-of-possession), pas string.

Alternatives :

- mTLS (certs client) : plus fort, complexité ops plus.
- Tokens bearer courte durée seulement comme phase temporaire (rotate + revoke tôt).

## Approbation silencieuse (heuristique SSH)

Définir précisément pour éviter lien faible. Préférer un :

- **Local-only** : auto-pair quand client connecte via loopback/socket Unix.
- **Challenge via SSH** : passerelle émet nonce ; client prouve SSH en fetchant.
- **Fenêtre présence physique** : après approbation locale sur UI host passerelle, autoriser auto-pair pour fenêtre courte (ex : 10 minutes).

Toujours logger + enregistrer auto-approbations.

---

# TLS partout (dev + prod)

## Réutiliser TLS bridge existant

Utiliser runtime TLS actuel + pinning fingerprint :

- `src/infra/bridge/server/tls.ts`
- logique vérification fingerprint dans `src/node-host/bridge-client.ts`

## Appliquer à WS

- Serveur WS supporte TLS avec même cert/key + fingerprint.
- Clients WS peuvent pin fingerprint (optionnel).
- Discovery advertise TLS + fingerprint pour tous endpoints.
  - Discovery est hints locator seulement ; jamais ancre confiance.

## Pourquoi

- Réduire dépendance SSH/Tailscale pour confidentialité.
- Rendre connexions mobiles distantes sûres par défaut.

---

# Redesign approbations (centralisé)

## Actuel

Approbation arrive sur node host (runtime node app mac). Prompt apparaît où node tourne.

## Proposé

Approbation est **hébergée passerelle**, UI délivrée vers clients operator.

### Nouveau flux

1. Passerelle reçoit intent `system.run` (agent).
2. Passerelle crée record approbation : `approval.requested`.
3. UI(s) operator affichent prompt.
4. Décision approbation envoyée à passerelle : `approval.resolve`.
5. Passerelle invoque commande node si approuvé.
6. Node exécute, retourne `invoke-res`.

### Sémantiques approbation (durcissement)

- Broadcast vers tous operators ; seulement UI active affiche modal (autres obtiennent toast).
- Première résolution gagne ; passerelle rejette résolves suivantes comme déjà settlées.
- Timeout défaut : refuser après N secondes (ex : 60s), logger raison.
- Résolution requiert scope `operator.approvals`.

## Bénéfices

- Prompt apparaît où user est (mac/téléphone).
- Approbations cohérentes pour nodes distants.
- Runtime node reste headless ; aucune dépendance UI.

---

# Exemples clarté rôle

## App iPhone

- **Rôle node** pour : mic, caméra, chat voix, location, push-to-talk.
- **operator.read** optionnel pour status et vue chat.
- **operator.write/admin** optionnel seulement quand explicitement activé.

## App macOS

- Rôle operator par défaut (UI contrôle).
- Rôle node quand "Mac node" activé (system.run, screen, caméra).
- Même deviceId pour deux connexions → entrée UI merged.

## CLI

- Rôle operator toujours.
- Scope dérivé par subcommand :
  - `status`, `logs` → read
  - `agent`, `message` → write
  - `config`, `channels` → admin
  - approbations + pairing → `operator.approvals` / `operator.pairing`

---

# Identité + slugs

## ID stable

Requis pour auth ; ne change jamais.
Préféré :

- Fingerprint keypair (hash clé publique).

## Slug cute (thème lobster)

Label humain seulement.

- Exemple : `scarlet-claw`, `saltwave`, `mantis-pinch`.
- Stocké dans registre passerelle, éditable.
- Gestion collision : `-2`, `-3`.

## Groupement UI

Même `deviceId` à travers rôles → ligne "Instance" unique :

- Badge : `operator`, `node`.
- Affiche capabilities + last seen.

---

# Stratégie migration

## Phase 0 : Documenter + aligner

- Publier ce doc.
- Inventorier tous appels protocole + flux approbation.

## Phase 1 : Ajouter rôles/scopes à WS

- Étendre params `connect` avec `role`, `scope`, `deviceId`.
- Ajouter gating allowlist pour rôle node.

## Phase 2 : Compatibilité bridge

- Garder bridge running.
- Ajouter support node WS en parallèle.
- Gate features derrière flag config.

## Phase 3 : Approbations centrales

- Ajouter requête approbation + résolution événements dans WS.
- Mettre à jour UI app mac pour prompt + répondre.
- Runtime node arrête prompt UI.

## Phase 4 : Unification TLS

- Ajouter config TLS pour WS utilisant runtime TLS bridge.
- Ajouter pinning aux clients.

## Phase 5 : Déprécier bridge

- Migrer iOS/Android/mac node vers WS.
- Garder bridge comme fallback ; supprimer une fois stable.

## Phase 6 : Auth device-bound

- Requérir identité key-based pour toutes connexions non-locales.
- Ajouter révocation + rotation UI.

---

# Notes sécurité

- Rôle/allowlist appliqués à limite passerelle.
- Aucun client n'obtient API "complète" sans scope operator.
- Pairing requis pour _toutes_ connexions.
- TLS + pinning réduit risque MITM pour mobile.
- Approbation silencieuse SSH est convenience ; toujours enregistrée + révocable.
- Discovery jamais ancre confiance.
- Claims capability vérifiées contre allowlists serveur par plateforme/type.

Voir aussi :

- [Protocole Passerelle](/fr-FR/gateway/protocol)
- [Protocole Bridge](/fr-FR/gateway/bridge-protocol)
- [Pairing](/fr-FR/gateway/pairing)
- [Sécurité](/fr-FR/gateway/security)
