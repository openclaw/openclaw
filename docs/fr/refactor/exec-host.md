---
summary: "Plan de refactorisation : routage de l’hôte d’exécution, approbations des nœuds et runner sans interface"
read_when:
  - Conception du routage de l’hôte d’exécution ou des approbations d’exécution
  - Implémentation du runner de nœud + IPC UI
  - Ajout des modes de sécurité de l’hôte d’exécution et des commandes slash
title: "Refactorisation de l’hôte d’exécution"
---

# Plan de refactorisation de l’hôte d’exécution

## Objectifs

- Ajouter `exec.host` + `exec.security` pour router l’exécution entre **sandbox**, **gateway** et **node**.
- Conserver des valeurs par défaut **sûres** : aucune exécution inter‑hôte sans activation explicite.
- Scinder l’exécution dans un **service de runner sans interface** avec UI optionnelle (app macOS) via IPC local.
- Fournir des politiques **par agent**, une allowlist, un mode « ask » et un rattachement de nœud.
- Prendre en charge des **modes ask** qui fonctionnent _avec_ ou _sans_ allowlists.
- Multi‑plateforme : socket Unix + authentification par jeton (parité macOS/Linux/Windows).

## Non‑objectifs

- Aucune migration d’allowlist héritée ni prise en charge de schémas hérités.
- Pas de PTY/streaming pour l’exécution sur nœud (sortie agrégée uniquement).
- Aucune nouvelle couche réseau au‑delà du Bridge + Gateway existants.

## Décisions (verrouillées)

- **Clés de configuration :** `exec.host` + `exec.security` (remplacement par agent autorisé).
- **Élévation :** conserver `/elevated` comme alias d’accès complet au gateway.
- **Ask par défaut :** `on-miss`.
- **Stockage des approbations :** `~/.openclaw/exec-approvals.json` (JSON, sans migration héritée).
- **Runner :** service système sans interface ; l’app UI héberge un socket Unix pour les approbations.
- **Identité du nœud :** utiliser l’existant `nodeId`.
- **Authentification du socket :** socket Unix + jeton (multi‑plateforme) ; scinder ultérieurement si nécessaire.
- **État de l’hôte de nœud :** `~/.openclaw/node.json` (id de nœud + jeton d’appairage).
- **Hôte d’exécution macOS :** exécuter `system.run` dans l’app macOS ; le service d’hôte de nœud relaie les requêtes via IPC local.
- **Pas de helper XPC :** rester sur socket Unix + jeton + vérifications de pairs.

## Concepts clés

### Hôte

- `sandbox` : exec Docker (comportement actuel).
- `gateway` : exec sur l’hôte du gateway.
- `node` : exec sur le runner de nœud via Bridge (`system.run`).

### Mode de sécurité

- `deny` : toujours bloquer.
- `allowlist` : autoriser uniquement les correspondances.
- `full` : tout autoriser (équivalent à élevé).

### Mode ask

- `off` : ne jamais demander.
- `on-miss` : demander uniquement lorsque l’allowlist ne correspond pas.
- `always` : demander à chaque fois.

Ask est **indépendant** de l’allowlist ; l’allowlist peut être utilisée avec `always` ou `on-miss`.

### Résolution de politique (par exécution)

1. Résoudre `exec.host` (paramètre de l’outil → remplacement par agent → valeur globale par défaut).
2. Résoudre `exec.security` et `exec.ask` (même priorité).
3. Si l’hôte est `sandbox`, procéder à l’exécution locale en sandbox.
4. Si l’hôte est `gateway` ou `node`, appliquer la politique de sécurité + ask sur cet hôte.

## Sécurité par défaut

- Par défaut `exec.host = sandbox`.
- Par défaut `exec.security = deny` pour `gateway` et `node`.
- Par défaut `exec.ask = on-miss` (pertinent uniquement si la sécurité l’autorise).
- Si aucun rattachement de nœud n’est défini, **l’agent peut cibler n’importe quel nœud**, mais uniquement si la politique l’autorise.

## Surface de configuration

### Paramètres de l'outil

- `exec.host` (optionnel) : `sandbox | gateway | node`.
- `exec.security` (optionnel) : `deny | allowlist | full`.
- `exec.ask` (optionnel) : `off | on-miss | always`.
- `exec.node` (optionnel) : id/nom du nœud à utiliser lorsque `host=node`.

### Clés de configuration (globales)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (rattachement de nœud par défaut)

### Clés de configuration (par agent)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### Alias

- `/elevated on` = définir `tools.exec.host=gateway`, `tools.exec.security=full` pour la session de l’agent.
- `/elevated off` = restaurer les paramètres d’exécution précédents pour la session de l’agent.

## Stockage des approbations (JSON)

Chemin : `~/.openclaw/exec-approvals.json`

Objectif :

- Politique locale + allowlists pour **l’hôte d’exécution** (gateway ou runner de nœud).
- Repli ask lorsque aucune UI n’est disponible.
- Identifiants IPC pour les clients UI.

Schéma proposé (v1) :

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64-opaque-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny"
  },
  "agents": {
    "agent-id-1": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [
        {
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 0,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

Notes :

- Aucun format d’allowlist hérité.
- `askFallback` s’applique uniquement lorsque `ask` est requis et qu’aucune UI n’est joignable.
- Permissions de fichier : `0600`.

## Service de runner (sans interface)

### Rôle

- Appliquer `exec.security` + `exec.ask` localement.
- Exécuter des commandes système et renvoyer la sortie.
- Émettre des événements Bridge pour le cycle de vie de l’exécution (optionnel mais recommandé).

### Cycle de vie du service

- Launchd/daemon sur macOS ; service système sur Linux/Windows.
- Le JSON des approbations est local à l’hôte d’exécution.
- L’UI héberge un socket Unix local ; les runners se connectent à la demande.

## Intégration UI (app macOS)

### IPC

- Socket Unix à `~/.openclaw/exec-approvals.sock` (0600).
- Jeton stocké dans `exec-approvals.json` (0600).
- Vérifications de pairs : même UID uniquement.
- Challenge/réponse : nonce + HMAC(token, request-hash) pour prévenir la relecture.
- TTL court (p. ex. 10 s) + taille de charge utile max + limitation de débit.

### Flux ask (hôte d’exécution app macOS)

1. Le service de nœud reçoit `system.run` depuis le gateway.
2. Le service de nœud se connecte au socket local et envoie l’invite/la requête d’exécution.
3. L’app valide le pair + le jeton + le HMAC + le TTL, puis affiche une boîte de dialogue si nécessaire.
4. L’app exécute la commande dans le contexte UI et renvoie la sortie.
5. Le service de nœud renvoie la sortie au gateway.

Si l’UI est absente :

- Appliquer `askFallback` (`deny|allowlist|full`).

### Diagramme (SCI)

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## Identité + rattachement de nœud

- Utiliser l’existant `nodeId` issu de l’appairage Bridge.
- Modèle de rattachement :
  - `tools.exec.node` restreint l’agent à un nœud spécifique.
  - S’il est non défini, l’agent peut choisir n’importe quel nœud (la politique applique toujours les valeurs par défaut).
- Résolution de sélection de nœud :
  - `nodeId` correspondance exacte
  - `displayName` (normalisé)
  - `remoteIp`
  - `nodeId` préfixe (≥ 6 caractères)

## Événementiel

### Qui voit les événements

- Les événements système sont **par session** et affichés à l’agent au prochain prompt.
- Stockés dans la file en mémoire du gateway (`enqueueSystemEvent`).

### Texte des événements

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + fin de sortie optionnelle
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### Transport

Option A (recommandée) :

- Le runner envoie des trames Bridge `event` `exec.started` / `exec.finished`.
- Le gateway `handleBridgeEvent` les mappe vers `enqueueSystemEvent`.

Option B :

- L’outil `exec` du gateway gère directement le cycle de vie (synchrone uniquement).

## Flux d’exécution

### Hôte sandbox

- Comportement existant `exec` (Docker ou hôte lorsque non en sandbox).
- PTY pris en charge uniquement en mode non‑sandbox.

### Hôte gateway

- Le processus gateway s’exécute sur sa propre machine.
- Applique `exec-approvals.json` local (sécurité/ask/allowlist).

### Hôte du noeud

- Le gateway appelle `node.invoke` avec `system.run`.
- Le runner applique les approbations locales.
- Le runner renvoie stdout/stderr agrégés.
- Événements Bridge optionnels pour début/fin/refus.

## Plafonds de sortie

- Plafonner stdout+stderr combinés à **200k** ; conserver **les 20k finaux** pour les événements.
- Tronquer avec un suffixe explicite (p. ex. `"… (truncated)"`).

## Commandes slash

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- Remplacements par agent et par session ; non persistants sauf sauvegarde via la configuration.
- `/elevated on|off|ask|full` reste un raccourci pour `host=gateway security=full` (avec `full` qui ignore les approbations).

## Histoire multi‑plateforme

- Le service de runner est la cible d’exécution portable.
- L’UI est optionnelle ; si absente, `askFallback` s’applique.
- Windows/Linux prennent en charge le même JSON d’approbations + protocole de socket.

## Phases d’implémentation

### Phase 1 : configuration + routage d’exécution

- Ajouter le schéma de configuration pour `exec.host`, `exec.security`, `exec.ask`, `exec.node`.
- Mettre à jour le câblage de l’outil pour respecter `exec.host`.
- Ajouter la commande slash `/exec` et conserver l’alias `/elevated`.

### Phase 2 : stockage des approbations + application côté gateway

- Implémenter le lecteur/rédacteur `exec-approvals.json`.
- Appliquer allowlist + modes ask pour l’hôte `gateway`.
- Ajouter des plafonds de sortie.

### Phase 3 : application côté runner de nœud

- Mettre à jour le runner de nœud pour appliquer allowlist + ask.
- Ajouter le pont d’invite par socket Unix vers l’UI de l’app macOS.
- Câbler `askFallback`.

### Phase 4 : événements

- Ajouter des événements Bridge nœud → gateway pour le cycle de vie d’exécution.
- Mapper vers `enqueueSystemEvent` pour les prompts d’agent.

### Phase 5 : finitions UI

- App Mac : éditeur d’allowlist, sélecteur par agent, UI de politique ask.
- Contrôles de rattachement de nœud (optionnels).

## Plan de tests

- Tests unitaires : correspondance d’allowlist (glob + insensible à la casse).
- Tests unitaires : priorité de résolution de politique (paramètre d’outil → remplacement par agent → global).
- Tests d’intégration : flux refuser/autoriser/demander du runner de nœud.
- Tests d’événements Bridge : événement de nœud → routage d’événement système.

## Risques ouverts

- Indisponibilité de l’UI : s’assurer que `askFallback` est respecté.
- Commandes longues : s’appuyer sur les délais d’expiration + plafonds de sortie.
- Ambiguïté multi‑nœuds : erreur sauf rattachement de nœud ou paramètre de nœud explicite.

## Documents connexes

- [Outil exec](/tools/exec)
- [Approbations exec](/tools/exec-approvals)
- [Nœuds](/nodes)
- [Mode élevé](/tools/elevated)
