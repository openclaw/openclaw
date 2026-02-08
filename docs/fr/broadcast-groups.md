---
summary: "Diffuser un message WhatsApp a plusieurs agents"
read_when:
  - Configuration des groupes de diffusion
  - Depannage des reponses multi-agents dans WhatsApp
status: experimental
title: "Groupes de diffusion"
x-i18n:
  source_path: broadcast-groups.md
  source_hash: eaeb4035912c4941
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:00:39Z
---

# Groupes de diffusion

**Statut :** Experimental  
**Version :** Ajoute dans 2026.1.9

## Vue d’ensemble

Les groupes de diffusion permettent a plusieurs agents de traiter et de repondre simultanement au meme message. Cela vous permet de creer des equipes d’agents specialises qui travaillent ensemble dans un seul groupe WhatsApp ou Message prive — le tout en utilisant un seul numero de telephone.

Portee actuelle : **WhatsApp uniquement** (canal web).

Les groupes de diffusion sont evalues apres les listes d’autorisation du canal et les regles d’activation des groupes. Dans les groupes WhatsApp, cela signifie que les diffusions ont lieu lorsque OpenClaw repondrait normalement (par exemple : sur mention, selon vos parametres de groupe).

## Cas d’utilisation

### 1. Equipes d’agents specialises

Deployer plusieurs agents avec des responsabilites atomiques et ciblees :

```
Group: "Development Team"
Agents:
  - CodeReviewer (reviews code snippets)
  - DocumentationBot (generates docs)
  - SecurityAuditor (checks for vulnerabilities)
  - TestGenerator (suggests test cases)
```

Chaque agent traite le meme message et fournit son point de vue specialise.

### 2. Support multilingue

```
Group: "International Support"
Agents:
  - Agent_EN (responds in English)
  - Agent_DE (responds in German)
  - Agent_ES (responds in Spanish)
```

### 3. Flux de travail d’assurance qualite

```
Group: "Customer Support"
Agents:
  - SupportAgent (provides answer)
  - QAAgent (reviews quality, only responds if issues found)
```

### 4. Automatisation des taches

```
Group: "Project Management"
Agents:
  - TaskTracker (updates task database)
  - TimeLogger (logs time spent)
  - ReportGenerator (creates summaries)
```

## Configuration

### Configuration de base

Ajoutez une section de premier niveau `broadcast` (a cote de `bindings`). Les cles sont des identifiants de pairs WhatsApp :

- discussions de groupe : JID de groupe (ex. `120363403215116621@g.us`)
- Messages prives : numero de telephone E.164 (ex. `+15551234567`)

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**Resultat :** Lorsque OpenClaw repondrait dans ce chat, il executera les trois agents.

### Strategie de traitement

Controlez la maniere dont les agents traitent les messages :

#### Parallele (par defaut)

Tous les agents traitent simultanement :

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

#### Sequentiel

Les agents traitent dans l’ordre (chacun attend que le precedent termine) :

```json
{
  "broadcast": {
    "strategy": "sequential",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

### Exemple complet

```json
{
  "agents": {
    "list": [
      {
        "id": "code-reviewer",
        "name": "Code Reviewer",
        "workspace": "/path/to/code-reviewer",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "security-auditor",
        "name": "Security Auditor",
        "workspace": "/path/to/security-auditor",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "docs-generator",
        "name": "Documentation Generator",
        "workspace": "/path/to/docs-generator",
        "sandbox": { "mode": "all" }
      }
    ]
  },
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["code-reviewer", "security-auditor", "docs-generator"],
    "120363424282127706@g.us": ["support-en", "support-de"],
    "+15555550123": ["assistant", "logger"]
  }
}
```

## Fonctionnement

### Flux des messages

1. **Message entrant** arrive dans un groupe WhatsApp
2. **Verification de diffusion** : le systeme verifie si l’ID du pair est dans `broadcast`
3. **S’il est dans la liste de diffusion** :
   - Tous les agents listes traitent le message
   - Chaque agent possede sa propre cle de session et un contexte isole
   - Les agents traitent en parallele (par defaut) ou de maniere sequentielle
4. **S’il n’est pas dans la liste de diffusion** :
   - Le routage normal s’applique (premiere liaison correspondante)

Remarque : les groupes de diffusion ne contournent pas les listes d’autorisation du canal ni les regles d’activation des groupes (mentions/commandes/etc.). Ils modifient uniquement _quels agents s’executent_ lorsqu’un message est eligible au traitement.

### Isolation des sessions

Chaque agent dans un groupe de diffusion conserve des elements completement separes :

- **Cles de session** (`agent:alfred:whatsapp:group:120363...` vs `agent:baerbel:whatsapp:group:120363...`)
- **Historique de conversation** (un agent ne voit pas les messages des autres)
- **Espace de travail** (sandboxes separees si configurees)
- **Acces aux outils** (listes d’autorisation/refus differentes)
- **Memoire/contexte** (IDENTITY.md, SOUL.md, etc. separes)
- **Tampon de contexte de groupe** (messages de groupe recents utilises pour le contexte) partage par pair, de sorte que tous les agents de diffusion voient le meme contexte lorsqu’ils sont declenches

Cela permet a chaque agent d’avoir :

- Des personnalites differentes
- Des acces aux outils differents (par ex. lecture seule vs lecture-ecriture)
- Des modeles differents (par ex. opus vs sonnet)
- Des Skills differents installes

### Exemple : sessions isolees

Dans le groupe `120363403215116621@g.us` avec les agents `["alfred", "baerbel"]` :

**Contexte d’Alfred :**

```
Session: agent:alfred:whatsapp:group:120363403215116621@g.us
History: [user message, alfred's previous responses]
Workspace: /Users/pascal/openclaw-alfred/
Tools: read, write, exec
```

**Contexte de Bärbel :**

```
Session: agent:baerbel:whatsapp:group:120363403215116621@g.us
History: [user message, baerbel's previous responses]
Workspace: /Users/pascal/openclaw-baerbel/
Tools: read only
```

## Bonnes pratiques

### 1. Garder les agents concentres

Concevez chaque agent avec une responsabilite unique et claire :

```json
{
  "broadcast": {
    "DEV_GROUP": ["formatter", "linter", "tester"]
  }
}
```

✅ **Bon :** chaque agent a une seule mission  
❌ **Mauvais :** un agent generique « dev-helper »

### 2. Utiliser des noms descriptifs

Rendez clair ce que fait chaque agent :

```json
{
  "agents": {
    "security-scanner": { "name": "Security Scanner" },
    "code-formatter": { "name": "Code Formatter" },
    "test-generator": { "name": "Test Generator" }
  }
}
```

### 3. Configurer des acces aux outils differents

Donnez aux agents uniquement les outils dont ils ont besoin :

```json
{
  "agents": {
    "reviewer": {
      "tools": { "allow": ["read", "exec"] } // Read-only
    },
    "fixer": {
      "tools": { "allow": ["read", "write", "edit", "exec"] } // Read-write
    }
  }
}
```

### 4. Surveiller les performances

Avec de nombreux agents, envisagez :

- D’utiliser `"strategy": "parallel"` (par defaut) pour la rapidite
- De limiter les groupes de diffusion a 5–10 agents
- D’utiliser des modeles plus rapides pour les agents simples

### 5. Gerer les echecs avec elegance

Les agents echouent independamment. L’erreur d’un agent ne bloque pas les autres :

```
Message → [Agent A ✓, Agent B ✗ error, Agent C ✓]
Result: Agent A and C respond, Agent B logs error
```

## Compatibilite

### Fournisseurs

Les groupes de diffusion fonctionnent actuellement avec :

- ✅ WhatsApp (implemente)
- 🚧 Telegram (prevu)
- 🚧 Discord (prevu)
- 🚧 Slack (prevu)

### Routage

Les groupes de diffusion fonctionnent en parallele du routage existant :

```json
{
  "bindings": [
    {
      "match": { "channel": "whatsapp", "peer": { "kind": "group", "id": "GROUP_A" } },
      "agentId": "alfred"
    }
  ],
  "broadcast": {
    "GROUP_B": ["agent1", "agent2"]
  }
}
```

- `GROUP_A` : seul alfred repond (routage normal)
- `GROUP_B` : agent1 ET agent2 repondent (diffusion)

**Priorite :** `broadcast` est prioritaire sur `bindings`.

## Depannage

### Les agents ne repondent pas

**Verifier :**

1. Les identifiants d’agents existent dans `agents.list`
2. Le format de l’ID de pair est correct (ex. `120363403215116621@g.us`)
3. Les agents ne sont pas dans des listes de refus

**Debogage :**

```bash
tail -f ~/.openclaw/logs/gateway.log | grep broadcast
```

### Un seul agent repond

**Cause :** l’ID de pair peut etre dans `bindings` mais pas dans `broadcast`.

**Correctif :** ajoutez-le a la configuration de diffusion ou retirez-le des liaisons.

### Problemes de performance

**Si lent avec de nombreux agents :**

- Reduisez le nombre d’agents par groupe
- Utilisez des modeles plus legers (sonnet au lieu d’opus)
- Verifiez le temps de demarrage de la sandbox

## Exemples

### Exemple 1 : equipe de revue de code

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": [
      "code-formatter",
      "security-scanner",
      "test-coverage",
      "docs-checker"
    ]
  },
  "agents": {
    "list": [
      {
        "id": "code-formatter",
        "workspace": "~/agents/formatter",
        "tools": { "allow": ["read", "write"] }
      },
      {
        "id": "security-scanner",
        "workspace": "~/agents/security",
        "tools": { "allow": ["read", "exec"] }
      },
      {
        "id": "test-coverage",
        "workspace": "~/agents/testing",
        "tools": { "allow": ["read", "exec"] }
      },
      { "id": "docs-checker", "workspace": "~/agents/docs", "tools": { "allow": ["read"] } }
    ]
  }
}
```

**L’utilisateur envoie :** extrait de code  
**Reponses :**

- code-formatter : « Indentation corrigee et annotations de type ajoutees »
- security-scanner : « ⚠️ Vulnerabilite d’injection SQL a la ligne 12 »
- test-coverage : « La couverture est de 45 %, des tests manquent pour les cas d’erreur »
- docs-checker : « Docstring manquante pour la fonction `process_data` »

### Exemple 2 : support multilingue

```json
{
  "broadcast": {
    "strategy": "sequential",
    "+15555550123": ["detect-language", "translator-en", "translator-de"]
  },
  "agents": {
    "list": [
      { "id": "detect-language", "workspace": "~/agents/lang-detect" },
      { "id": "translator-en", "workspace": "~/agents/translate-en" },
      { "id": "translator-de", "workspace": "~/agents/translate-de" }
    ]
  }
}
```

## Reference API

### Schema de configuration

```typescript
interface OpenClawConfig {
  broadcast?: {
    strategy?: "parallel" | "sequential";
    [peerId: string]: string[];
  };
}
```

### Champs

- `strategy` (optionnel) : comment traiter les agents
  - `"parallel"` (par defaut) : tous les agents traitent simultanement
  - `"sequential"` : les agents traitent selon l’ordre du tableau
- `[peerId]` : JID de groupe WhatsApp, numero E.164 ou autre ID de pair
  - Valeur : tableau d’identifiants d’agents devant traiter les messages

## Limitations

1. **Nombre maximal d’agents :** pas de limite stricte, mais 10+ agents peuvent etre lents
2. **Contexte partage :** les agents ne voient pas les reponses des autres (par conception)
3. **Ordre des messages :** les reponses paralleles peuvent arriver dans n’importe quel ordre
4. **Limites de taux :** tous les agents comptent dans les limites de taux WhatsApp

## Evolutions futures

Fonctionnalites prevues :

- [ ] Mode de contexte partage (les agents voient les reponses des autres)
- [ ] Coordination des agents (les agents peuvent se signaler entre eux)
- [ ] Selection dynamique des agents (choisir les agents selon le contenu du message)
- [ ] Priorites des agents (certains agents repondent avant les autres)

## Voir aussi

- [Configuration multi-agents](/multi-agent-sandbox-tools)
- [Configuration du routage](/concepts/channel-routing)
- [Gestion des sessions](/concepts/sessions)
