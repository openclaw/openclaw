---
summary: "Approbations exec, allowlists et prompts escape sandbox"
read_when:
  - Configuration approbations exec ou allowlists
  - Implémentation UX approbation exec dans app macOS
  - Review prompts escape sandbox et implications
title: "Approbations Exec"
---

# Approbations Exec

Approbations exec sont **guardrail app companion / node host** pour laisser agent sandboxed exécuter commandes sur host réel (`gateway` ou `node`). Pensez comme interlock sécurité : commandes autorisées seulement quand politique + allowlist + (optionnel) approbation user tous d'accord.

Approbations exec sont **en addition** à politique tool et gating elevated (sauf si elevated défini à `full`, qui skip approbations). Politique effective est **plus stricte** de `tools.exec.*` et défauts approbations ; si champ approbations omis, valeur `tools.exec` utilisée.

Si UI app companion **non disponible**, n'importe quelle requête nécessitant prompt résolue par **fallback ask** (défaut : deny).

## Où ça s'applique

Approbations exec appliquées localement sur host exécution :

- **host gateway** → processus `openclaw` sur machine passerelle
- **host node** → runner node (app companion macOS ou node host headless)

Split macOS :

- **Service host node** forward `system.run` vers **app macOS** via IPC local.
- **App macOS** applique approbations + exécute commande dans contexte UI.

## Settings et stockage

Approbations vivent dans fichier JSON local sur host exécution :

`~/.openclaw/exec-approvals.json`

Exemple schéma :

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

## Boutons politique

### Security (`exec.security`)

- **deny** : bloquer toutes requêtes exec host.
- **allowlist** : autoriser seulement commandes allowlistées.
- **full** : autoriser tout (équivalent elevated).

### Ask (`exec.ask`)

- **off** : jamais demander.
- **on-miss** : demander seulement quand allowlist ne correspond pas.
- **always** : demander à chaque fois.

### Ask Fallback (`exec.askFallback`)

Quand UI unavailable :

- **deny** : rejeter requête.
- **allow** : permettre requête (dangereux).

### Auto-Allow Skills

- `autoAllowSkills: true` : autoriser automatiquement commandes depuis répertoire skills workspace.
- Utile pour skills custom nécessitant exec sans prompts répétés.

## Gestion Allowlist

**Ajouter entrée :**

```bash
openclaw approvals allowlist add --node <nodeId> "/usr/bin/uname"
```

**Lister entrées :**

```bash
openclaw approvals get --node <nodeId>
```

**Supprimer entrée :**

```bash
openclaw approvals allowlist remove --node <nodeId> --id <entryId>
```

## Flux approbation

1. Agent appelle tool exec (`system.run`)
2. Host vérifie politique security
3. Si `deny` : rejeter immédiatement
4. Si `full` : autoriser immédiatement
5. Si `allowlist` : vérifier allowlist
   - Match trouvé : autoriser
   - Pas match + `ask: "on-miss"` : prompt user
   - Pas match + `ask: "off"` : rejeter
6. User approuve/rejette (si prompt affiché)
7. Exécuter commande si approuvé

## Prompts escape sandbox

Approbations exec empêchent agent sandboxed accéder host sans permission. Implications :

**Risques :**

- Accès filesystem host
- Exécution commandes arbitraires
- Exfiltration données
- Modification système

**Mitigations :**

- Politique `deny` par défaut
- Allowlists explicites
- Prompts user pour nouvelles commandes
- Logs audit complets
- Mode elevated séparé pour cas trusted

## Configuration

```json5
{
  agents: {
    defaults: {
      exec: {
        security: "allowlist",
        ask: "on-miss",
        askFallback: "deny",
        autoAllowSkills: true,
      },
    },
    list: [
      {
        id: "research",
        exec: {
          security: "deny", // Override : aucun exec pour agent research
        },
      },
    ],
  },
}
```

## Dépannage

**Commandes bloquées :**

```bash
# Vérifier politique
openclaw config get agents.defaults.exec.security

# Vérifier allowlist
openclaw approvals get --node <nodeId>

# Ajouter à allowlist
openclaw approvals allowlist add --node <nodeId> "<commande>"
```

**Prompts pas affichés :**

- Vérifier app macOS tourne (si node macOS)
- Vérifier `exec.ask` pas défini à `"off"`
- Vérifier `exec.askFallback` pour comportement quand UI unavailable

Voir aussi :

- [Mode Elevated](/fr-FR/tools/elevated)
- [Sandboxing](/fr-FR/gateway/sandboxing)
- [Nodes](/fr-FR/nodes/index)
- [Sécurité](/fr-FR/gateway/security)
