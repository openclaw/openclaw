---
summary: "Refonte de Clawnet : unifier le protocole réseau, les rôles, l’authentification, les validations et l’identité"
read_when:
  - Planifier un protocole réseau unifié pour les nœuds et les clients opérateurs
  - Revoir les validations, l’appairage, TLS et la présence entre appareils
title: "Refonte de Clawnet"
---

# Refonte de Clawnet (unification protocole + auth)

## Salut

Salut Peter — excellente direction ; cela ouvre la voie à une UX plus simple et à une sécurité renforcée.

## Objectif

Document unique et rigoureux pour :

- État actuel : protocoles, flux, frontières de confiance.
- Points de friction : validations, routage multi‑sauts, duplication UI.
- Nouvel état proposé : un protocole, rôles à portée limitée, auth/appairage unifiés, pinning TLS.
- Modèle d’identité : identifiants stables + slugs « mignons ».
- Plan de migration, risques, questions ouvertes.

## Objectifs (issus de la discussion)

- Un protocole pour tous les clients (app mac, CLI, iOS, Android, nœud headless).
- Chaque participant réseau authentifié + appairé.
- Clarté des rôles : nœuds vs opérateurs.
- Validations centralisées, routées là où se trouve l’utilisateur.
- Chiffrement TLS + pinning optionnel pour tout le trafic distant.
- Duplication de code minimale.
- Une machine n’apparaît qu’une seule fois (pas de doublon UI/nœud).

## Non‑objectifs (explicites)

- Supprimer la séparation des capacités (le moindre privilège reste requis).
- Exposer l’intégralité du plan de contrôle de la Gateway (passerelle) sans contrôles de portée.
- Faire dépendre l’authentification d’étiquettes humaines (les slugs restent non sécuritaires).

---

# État actuel (tel quel)

## Deux protocoles

### 1. Gateway WebSocket (plan de contrôle)

- Surface API complète : config, canaux, modèles, sessions, exécutions d’agents, logs, nœuds, etc.
- Liaison par défaut : loopback. Accès distant via SSH/Tailscale.
- Auth : jeton/mot de passe via `connect`.
- Pas de pinning TLS (dépend du loopback/tunnel).
- Code :
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2. Bridge (transport des nœuds)

- Surface à liste blanche étroite, identité de nœud + appairage.
- JSONL sur TCP ; TLS optionnel + pinning d’empreinte de certificat.
- TLS annonce l’empreinte dans le TXT de découverte.
- Code :
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## Clients du plan de contrôle aujourd’hui

- CLI → Gateway WS via `callGateway` (`src/gateway/call.ts`).
- UI de l’app macOS → Gateway WS (`GatewayConnection`).
- UI de contrôle Web → Gateway WS.
- ACP → Gateway WS.
- Le contrôle via navigateur utilise son propre serveur HTTP de contrôle.

## Nœuds aujourd’hui

- App macOS en mode nœud se connecte au bridge de la Gateway (`MacNodeBridgeSession`).
- Apps iOS/Android se connectent au bridge de la Gateway.
- Appairage + jeton par nœud stockés sur la gateway.

## Flux de validation actuel (exec)

- L’agent utilise `system.run` via la Gateway.
- La Gateway invoque le nœud via le bridge.
- Le runtime du nœud décide de la validation.
- Une invite UI est affichée par l’app mac (quand le nœud == app mac).
- Le nœud renvoie `invoke-res` à la Gateway.
- Multi‑sauts, UI liée à l’hôte du nœud.

## Présence + identité aujourd’hui

- Entrées de présence Gateway depuis les clients WS.
- Entrées de présence des nœuds depuis le bridge.
- L’app mac peut afficher deux entrées pour la même machine (UI + nœud).
- Identité du nœud stockée dans le magasin d’appairage ; identité UI séparée.

---

# Problèmes / points de friction

- Deux piles de protocoles à maintenir (WS + Bridge).
- Validations sur des nœuds distants : l’invite apparaît sur l’hôte du nœud, pas là où se trouve l’utilisateur.
- Le pinning TLS n’existe que pour le bridge ; WS dépend de SSH/Tailscale.
- Duplication d’identité : une même machine apparaît comme plusieurs instances.
- Rôles ambigus : capacités UI + nœud + CLI pas clairement séparées.

---

# Nouvel état proposé (Clawnet)

## Un protocole, deux rôles

Un protocole WS unique avec rôle + portée.

- **Rôle : nœud** (hôte de capacités)
- **Rôle : opérateur** (plan de contrôle)
- **Portée** optionnelle pour l’opérateur :
  - `operator.read` (statut + consultation)
  - `operator.write` (exécution d’agent, envois)
  - `operator.admin` (config, canaux, modèles)

### Comportements par rôle

**Nœud**

- Peut enregistrer des capacités (`caps`, `commands`, permissions).
- Peut recevoir des commandes `invoke` (`system.run`, `camera.*`, `canvas.*`, `screen.record`, etc.).
- Peut envoyer des événements : `voice.transcript`, `agent.request`, `chat.subscribe`.
- Ne peut pas appeler les API du plan de contrôle (config/modèles/canaux/sessions/agents).

**Opérateur**

- API complète du plan de contrôle, filtrée par portée.
- Reçoit toutes les validations.
- N’exécute pas directement des actions OS ; route vers les nœuds.

### Règle clé

Le rôle est par connexion, pas par appareil. Un appareil peut ouvrir les deux rôles, séparément.

---

# Authentification + appairage unifiés

## Identité client

Chaque client fournit :

- `deviceId` (stable, dérivé de la clé de l’appareil).
- `displayName` (nom humain).
- `role` + `scope` + `caps` + `commands`.

## Flux d’appairage (unifié)

- Le client se connecte sans être authentifié.
- La Gateway crée une **demande d’appairage** pour cet `deviceId`.
- L’opérateur reçoit une invite ; approuve/refuse.
- La Gateway émet des identifiants liés à :
  - la clé publique de l’appareil
  - le(s) rôle(s)
  - la/les portée(s)
  - les capacités/commandes
- Le client persiste le jeton, se reconnecte authentifié.

## Auth liée à l’appareil (éviter la relecture de jetons porteurs)

Préféré : paires de clés par appareil.

- L’appareil génère une paire de clés une fois.
- `deviceId = fingerprint(publicKey)`.
- La Gateway envoie un nonce ; l’appareil signe ; la Gateway vérifie.
- Les jetons sont émis pour une clé publique (preuve de possession), pas une chaîne.

Alternatives :

- mTLS (certificats client) : le plus robuste, plus complexe opérationnellement.
- Jetons porteurs à courte durée de vie uniquement comme phase transitoire (rotation + révocation anticipée).

## Approbation silencieuse (heuristique SSH)

La définir précisément pour éviter un maillon faible. Préférer une option :

- **Local uniquement** : appairage automatique lorsque le client se connecte via loopback/socket Unix.
- **Défi via SSH** : la Gateway émet un nonce ; le client prouve l’accès SSH en le récupérant.
- **Fenêtre de présence physique** : après une validation locale sur l’UI de l’hôte de la Gateway, autoriser l’auto‑appairage pendant une courte fenêtre (p. ex. 10 minutes).

Toujours journaliser et enregistrer les auto‑validations.

---

# TLS partout (dev + prod)

## Réutiliser le TLS existant du bridge

Utiliser le runtime TLS actuel + pinning d’empreinte :

- `src/infra/bridge/server/tls.ts`
- logique de vérification d’empreinte dans `src/node-host/bridge-client.ts`

## Appliquer à WS

- Le serveur WS prend en charge TLS avec le même cert/clé + empreinte.
- Les clients WS peuvent pinner l’empreinte (optionnel).
- La découverte annonce TLS + empreinte pour tous les endpoints.
  - La découverte n’est qu’un indice de localisation ; jamais une ancre de confiance.

## Pourquoi

- Réduire la dépendance à SSH/Tailscale pour la confidentialité.
- Rendre les connexions mobiles distantes sûres par défaut.

---

# Refonte des validations (centralisées)

## Actuel

La validation a lieu sur l’hôte du nœud (runtime nœud de l’app mac). L’invite apparaît là où le nœud s’exécute.

## Proposé

La validation est **hébergée par la Gateway**, avec UI livrée aux clients opérateurs.

### Nouveau flux

1. La Gateway reçoit l’intention `system.run` (agent).
2. La Gateway crée un enregistrement de validation : `approval.requested`.
3. Les UI opérateurs affichent l’invite.
4. La décision de validation est envoyée à la Gateway : `approval.resolve`.
5. La Gateway invoque la commande du nœud si approuvée.
6. Le nœud exécute et renvoie `invoke-res`.

### Sémantique des validations (durcissement)

- Diffusion à tous les opérateurs ; seule l’UI active affiche une modale (les autres reçoivent une notification).
- La première résolution l’emporte ; la Gateway rejette les résolutions ultérieures comme déjà traitées.
- Délai par défaut : refus après N secondes (p. ex. 60 s), raison journalisée.
- La résolution requiert la portée `operator.approvals`.

## Bénéfices

- L’invite apparaît là où se trouve l’utilisateur (mac/téléphone).
- Validations cohérentes pour les nœuds distants.
- Le runtime du nœud reste headless ; aucune dépendance UI.

---

# Exemples de clarté des rôles

## App iPhone

- **Rôle nœud** pour : micro, caméra, chat vocal, localisation, push‑to‑talk.
- **operator.read** optionnel pour le statut et la vue des chats.
- **operator.write/admin** optionnel uniquement si explicitement activé.

## App macOS

- Rôle opérateur par défaut (UI de contrôle).
- Rôle nœud lorsque « Mac node » est activé (system.run, écran, caméra).
- Même deviceId pour les deux connexions → entrée UI fusionnée.

## CLI

- Rôle opérateur toujours.
- Portée dérivée de la sous‑commande :
  - `status`, `logs` → read
  - `agent`, `message` → write
  - `config`, `channels` → admin
  - validations + appairage → `operator.approvals` / `operator.pairing`

---

# Identité + slugs

## ID stable

Requis pour l’authentification ; ne change jamais.
Préféré :

- Empreinte de la paire de clés (hachage de la clé publique).

## Slug « mignon » (thème homard)

Étiquette humaine uniquement.

- Exemples : `scarlet-claw`, `saltwave`, `mantis-pinch`.
- Stocké dans le registre de la Gateway, modifiable.
- Gestion des collisions : `-2`, `-3`.

## Regroupement UI

Même `deviceId` entre rôles → une seule ligne « Instance » :

- Badge : `operator`, `node`.
- Affiche les capacités + dernière activité.

---

# Stratégie de migration

## Phase 0 : Documenter + aligner

- Publier ce document.
- Inventorier tous les appels de protocole + flux de validation.

## Phase 1 : Ajouter rôles/portées à WS

- Étendre les paramètres `connect` avec `role`, `scope`, `deviceId`.
- Ajouter un filtrage par liste blanche pour le rôle nœud.

## Phase 2 : Compatibilité bridge

- Conserver le bridge en fonctionnement.
- Ajouter le support des nœuds WS en parallèle.
- Masquer les fonctionnalités derrière un drapeau de config.

## Phase 3 : Validations centralisées

- Ajouter des événements de demande/résolution de validation en WS.
- Mettre à jour l’UI de l’app mac pour inviter + répondre.
- Le runtime du nœud cesse d’afficher des invites UI.

## Phase 4 : Unification TLS

- Ajouter la config TLS pour WS en utilisant le runtime TLS du bridge.
- Ajouter le pinning côté clients.

## Phase 5 : Déprécier le bridge

- Migrer les nœuds iOS/Android/mac vers WS.
- Conserver le bridge comme repli ; le retirer une fois stable.

## Phase 6 : Auth liée à l’appareil

- Exiger une identité basée sur des clés pour toutes les connexions non locales.
- Ajouter UI de révocation + rotation.

---

# Notes de sécurité

- Rôle/liste blanche appliqués à la frontière de la Gateway.
- Aucun client n’obtient l’API « complète » sans portée opérateur.
- Appairage requis pour _toutes_ les connexions.
- TLS + pinning réduit le risque MITM pour le mobile.
- L’approbation silencieuse SSH est une commodité ; toujours enregistrée + révocable.
- La découverte n’est jamais une ancre de confiance.
- Les revendications de capacités sont vérifiées par rapport aux listes blanches serveur par plateforme/type.

# Streaming + charges utiles volumineuses (médias nœud)

Le plan de contrôle WS convient aux petits messages, mais les nœuds font aussi :

- clips caméra
- enregistrements d’écran
- flux audio

Options :

1. Trames binaires WS + découpage + règles de backpressure.
2. Endpoint de streaming séparé (toujours TLS + auth).
3. Conserver le bridge plus longtemps pour les commandes lourdes en média, migrer en dernier.

Choisir avant l’implémentation pour éviter les dérives.

# Politique capacités + commandes

- Les capacités/commandes rapportées par le nœud sont traitées comme des **revendications**.
- La Gateway applique des listes blanches par plateforme.
- Toute nouvelle commande requiert une validation opérateur ou un changement explicite de liste blanche.
- Auditer les changements avec horodatage.

# Audit + limitation de débit

- Journaliser : demandes d’appairage, validations/refus, émission/rotation/révocation de jetons.
- Limiter le débit du spam d’appairage et des invites de validation.

# Hygiène du protocole

- Version de protocole explicite + codes d’erreur.
- Règles de reconnexion + politique de heartbeat.
- TTL de présence et sémantique « dernier vu ».

---

# Questions ouvertes

1. Un seul appareil exécutant les deux rôles : modèle de jeton
   - Recommander des jetons séparés par rôle (nœud vs opérateur).
   - Même deviceId ; portées différentes ; révocation plus claire.

2. Granularité des portées opérateur
   - read/write/admin + validations + appairage (minimum viable).
   - Envisager des portées par fonctionnalité plus tard.

3. UX de rotation + révocation des jetons
   - Rotation automatique lors d’un changement de rôle.
   - UI pour révoquer par deviceId + rôle.

4. Découverte
   - Étendre le TXT Bonjour actuel pour inclure l’empreinte TLS WS + des indices de rôle.
   - Traiter comme de simples indices de localisation.

5. Approbation du réseau croisé
   - Diffusion à tous les clients opérateurs ; l’UI active affiche la modale.
   - La première réponse l’emporte ; la Gateway garantit l’atomicité.

---

# Résumé (TL;DR)

- Aujourd’hui : plan de contrôle WS + transport de nœuds Bridge.
- Douleurs : validations + duplication + deux piles.
- Proposition : un protocole WS avec rôles + portées explicites, appairage unifié + pinning TLS, validations hébergées par la Gateway, IDs d’appareils stables + slugs mignons.
- Résultat : UX plus simple, sécurité renforcée, moins de duplication, meilleur routage mobile.
