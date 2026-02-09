---
summary: "Approbations d’exécution, listes d’autorisation et invites d’échappement du sandbox"
read_when:
  - Configuration des approbations d’exécution ou des listes d’autorisation
  - Implémentation de l’UX d’approbation d’exécution dans l’application macOS
  - Revue des invites d’échappement du sandbox et de leurs implications
title: "Approbations d’exécution"
---

# Approbations d’exécution

Les approbations d’exécution constituent la **barrière de sécurité de l’application compagnon / de l’hôte de nœud** permettant à un agent en sandbox d’exécuter des commandes sur un hôte réel (`gateway` ou `node`). Considérez‑les comme un interverrouillage de sécurité : les commandes ne sont autorisées que lorsque la politique + la liste d’autorisation + (facultativement) l’approbation de l’utilisateur sont toutes d’accord.
Les approbations d’exécution s’ajoutent **en plus** de la politique d’outils et du contrôle d’élévation (sauf si l’élévation est définie sur `full`, ce qui ignore les approbations).
La politique effective est la **plus stricte** entre `tools.exec.*` et les valeurs par défaut des approbations ; si un champ d’approbations est omis, la valeur `tools.exec` est utilisée.

Si l’interface de l’application compagnon **n’est pas disponible**, toute requête nécessitant une invite est
résolue par le **repli ask** (par défaut : refus).

## Où cela s’applique

Les approbations d’exécution sont appliquées localement sur l’hôte d’exécution :

- **hôte gateway** → processus `openclaw` sur la machine gateway
- **hôte de nœud** → exécuteur de nœud (application compagnon macOS ou hôte de nœud sans interface)

Séparation macOS :

- Le **service d’hôte de nœud** transfère `system.run` vers l’**application macOS** via IPC local.
- L’**application macOS** applique les approbations + exécute la commande dans le contexte UI.

## Paramètres et stockage

Les approbations résident dans un fichier JSON local sur l’hôte d’exécution :

`~/.openclaw/exec-approvals.json`

Schéma d’exemple :

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## Réglages de politique

### Sécurité (`exec.security`)

- **deny** : bloquer toutes les requêtes d’exécution sur l’hôte.
- **allowlist** : autoriser uniquement les commandes présentes dans la liste d’autorisation.
- **full** : tout autoriser (équivalent à élevé).

### Ask (`exec.ask`)

- **off** : ne jamais demander.
- **on-miss** : demander uniquement lorsque la liste d’autorisation ne correspond pas.
- **always** : demander pour chaque commande.

### Repli Ask (`askFallback`)

Si une invite est requise mais qu’aucune UI n’est accessible, le repli décide :

- **deny** : bloquer.
- **allowlist** : autoriser uniquement si la liste d’autorisation correspond.
- **full** : autoriser.

## Liste d’autorisation (par agent)

Les listes d’autorisation sont **par agent**. S’il existe plusieurs agents, changez l’agent que vous modifiez dans l’application macOS. Les motifs sont des **correspondances glob insensibles à la casse**.
Les motifs doivent se résoudre en **chemins de binaires** (les entrées limitées au nom de base sont ignorées).
Les entrées héritées `agents.default` sont migrées vers `agents.main` au chargement.

Exemples :

- `~/Projects/**/bin/bird`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

Chaque entrée de la liste d’autorisation suit :

- **id** : UUID stable utilisé pour l’identité UI (facultatif)
- **last used** : horodatage de la dernière utilisation
- **last used command**
- **last resolved path**

## Auto‑autorisation des CLI de Skills

Lorsque **Auto‑autoriser les CLI de Skills** est activé, les exécutables référencés par des Skills connus
sont traités comme autorisés sur les nœuds (nœud macOS ou hôte de nœud sans interface). Cela utilise
`skills.bins` via le RPC Gateway pour récupérer la liste des binaires de Skills. Désactivez cette option si vous souhaitez des listes d’autorisation manuelles strictes.

## Binaires sûrs (stdin uniquement)

`tools.exec.safeBins` définit une petite liste de binaires **stdin‑only** (par exemple `jq`)
qui peuvent s’exécuter en mode liste d’autorisation **sans** entrées explicites dans la liste d’autorisation. Les binaires sûrs rejettent
les arguments positionnels de fichiers et les jetons de type chemin, afin qu’ils ne puissent opérer que sur le flux entrant.
L’enchaînement de shells et les redirections ne sont pas auto‑autorisés en mode liste d’autorisation.

L’enchaînement de shells (`&&`, `||`, `;`) est autorisé lorsque chaque segment de niveau supérieur satisfait la liste d’autorisation
(y compris les binaires sûrs ou l’auto‑autorisation des Skills). Les redirections restent non prises en charge en mode liste d’autorisation.
La substitution de commande (`$()` / backticks) est rejetée lors de l’analyse de la liste d’autorisation, y compris à l’intérieur
des guillemets doubles ; utilisez des guillemets simples si vous avez besoin de texte littéral `$()`.

Binaires sûrs par défaut : `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## Édition via l’UI de contrôle

Utilisez la carte **UI de contrôle → Nœuds → Approbations d’exécution** pour modifier les valeurs par défaut, les remplacements par agent
et les listes d’autorisation. Choisissez une portée (Valeurs par défaut ou un agent), ajustez la politique,
ajoutez/supprimez des motifs de liste d’autorisation, puis **Enregistrer**. L’UI affiche les métadonnées **last used**
par motif afin de garder la liste propre.

Le sélecteur de cible choisit **Gateway** (approbations locales) ou un **Nœud**. Les nœuds
doivent annoncer `system.execApprovals.get/set` (application macOS ou hôte de nœud sans interface).
Si un nœud n’annonce pas encore les approbations d’exécution, modifiez directement son
`~/.openclaw/exec-approvals.json` local.

CLI : `openclaw approvals` prend en charge l’édition côté gateway ou nœud (voir [Approvals CLI](/cli/approvals)).

## Flux d’approbation

Lorsqu’une invite est requise, la gateway diffuse `exec.approval.requested` aux clients opérateurs.
L’UI de contrôle et l’application macOS la résolvent via `exec.approval.resolve`, puis la gateway transfère la
requête approuvée à l’hôte de nœud.

Lorsque des approbations sont requises, l’outil exec retourne immédiatement avec un identifiant d’approbation. Utilisez cet identifiant pour
corréler les événements système ultérieurs (`Exec finished` / `Exec denied`). Si aucune décision n’arrive avant
l’expiration du délai, la requête est traitée comme un délai d’approbation dépassé et présentée comme un motif de refus.

La boîte de dialogue de confirmation inclut :

- commande + arguments
- cwd
- id de l’agent
- chemin de l’exécutable résolu
- métadonnées de l’hôte + de la politique

Actions :

- **Autoriser une fois** → exécuter maintenant
- **Toujours autoriser** → ajouter à la liste d’autorisation + exécuter
- **Refuser** → bloquer

## Transmission des approbations vers les canaux de discussion

Vous pouvez transmettre les invites d’approbation d’exécution vers n’importe quel canal de discussion (y compris les canaux de plugins) et les approuver
avec `/approve`. Cela utilise le pipeline de diffusion sortante normal.

Configuration :

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring or regex
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

Répondre dans le chat :

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### Flux IPC macOS

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

Notes de sécurité :

- Mode de socket Unix `0600`, jeton stocké dans `exec-approvals.json`.
- Vérification du pair de même UID.
- Défi/réponse (nonce + jeton HMAC + hachage de requête) + TTL court.

## Événements système

Le cycle de vie exec est exposé sous forme de messages système :

- `Exec running` (uniquement si la commande dépasse le seuil de notification d’exécution)
- `Exec finished`
- `Exec denied`

Ils sont publiés dans la session de l’agent après que le nœud a signalé l’événement.
Les approbations d’exécution côté hôte gateway émettent les mêmes événements de cycle de vie lorsque la commande se termine (et éventuellement lorsqu’elle s’exécute plus longtemps que le seuil).
Les exécutions soumises à approbation réutilisent l’identifiant d’approbation comme `runId` dans ces messages pour une corrélation facile.

## Implications

- **full** est puissant ; préférez les listes d’autorisation lorsque c’est possible.
- **ask** vous maintient dans la boucle tout en permettant des approbations rapides.
- Les listes d’autorisation par agent empêchent que les approbations d’un agent ne se propagent à d’autres.
- Les approbations ne s’appliquent qu’aux requêtes d’exécution sur l’hôte provenant d’**expéditeurs autorisés**. Les expéditeurs non autorisés ne peuvent pas émettre `/exec`.
- `/exec security=full` est une commodité au niveau de la session pour les opérateurs autorisés et ignore les approbations par conception.
  Pour bloquer strictement l’exécution sur l’hôte, définissez la sécurité des approbations sur `deny` ou refusez l’outil `exec` via la politique d’outils.

Liens associés :

- [Outil exec](/tools/exec)
- [Mode élevé](/tools/elevated)
- [Skills](/tools/skills)
