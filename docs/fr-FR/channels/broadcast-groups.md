---
summary: "Diffuser un message WhatsApp à plusieurs agents"
read_when:
  - Configuration de groupes de diffusion
  - Débogage de réponses multi-agents dans WhatsApp
status: experimental
title: "Groupes de Diffusion"
---

# Groupes de Diffusion

**Statut :** Expérimental  
**Version :** Ajouté dans 2026.1.9

## Aperçu

Les Groupes de Diffusion permettent à plusieurs agents de traiter et répondre au même message simultanément. Cela vous permet de créer des équipes d'agents spécialisés qui travaillent ensemble dans un seul groupe WhatsApp ou DM — le tout en utilisant un seul numéro de téléphone.

Portée actuelle : **WhatsApp uniquement** (canal web).

Les groupes de diffusion sont évalués après les listes d'autorisation de canal et les règles d'activation de groupe. Dans les groupes WhatsApp, cela signifie que les diffusions se produisent quand OpenClaw répondrait normalement (par exemple : sur mention, selon vos paramètres de groupe).

## Cas d'usage

### 1. Équipes d'agents spécialisés

Déployez plusieurs agents avec des responsabilités atomiques et ciblées :

```
Groupe : "Équipe de Développement"
Agents :
  - CodeReviewer (révise les extraits de code)
  - DocumentationBot (génère la documentation)
  - SecurityAuditor (vérifie les vulnérabilités)
  - TestGenerator (suggère des cas de test)
```

Chaque agent traite le même message et fournit sa perspective spécialisée.

### 2. Support multi-langues

```
Groupe : "Support International"
Agents :
  - Agent_FR (répond en français)
  - Agent_EN (répond en anglais)
  - Agent_ES (répond en espagnol)
```

### 3. Workflows d'assurance qualité

```
Groupe : "Support Client"
Agents :
  - SupportAgent (fournit la réponse)
  - QAAgent (révise la qualité, répond uniquement si problèmes trouvés)
```

## Configuration

### Configuration de base

Ajoutez une section `broadcast` de niveau supérieur (à côté de `bindings`). Les clés sont des identifiants de pair WhatsApp :

- chats de groupe : JID de groupe (par ex., `120363403215116621@g.us`)
- DM : numéro de téléphone E.164 (par ex., `+15551234567`)

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**Résultat :** Quand OpenClaw répondrait dans ce chat, il exécutera les trois agents.

### Stratégie de traitement

Contrôlez comment les agents traitent les messages :

#### Parallèle (Par défaut)

Tous les agents traitent simultanément :

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

#### Séquentiel

Les agents traitent dans l'ordre (un attend que le précédent finisse) :

```json
{
  "broadcast": {
    "strategy": "sequential",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

## Isolation de session

Chaque agent dans un groupe de diffusion maintient complètement séparés :

- **Clés de session** (`agent:alfred:whatsapp:group:120363...` vs `agent:baerbel:whatsapp:group:120363...`)
- **Historique de conversation** (l'agent ne voit pas les messages des autres agents)
- **Espace de travail** (sandboxes séparés si configurés)
- **Accès aux outils** (listes allow/deny différentes)
- **Mémoire/contexte** (IDENTITY.md, SOUL.md séparés, etc.)

## Meilleures pratiques

### 1. Gardez les agents ciblés

Concevez chaque agent avec une responsabilité unique et claire :

```json
{
  "broadcast": {
    "DEV_GROUP": ["formatter", "linter", "tester"]
  }
}
```

✅ **Bon :** Chaque agent a un travail  
❌ **Mauvais :** Un agent générique "dev-helper"

### 2. Utilisez des noms descriptifs

Rendez clair ce que fait chaque agent :

```json
{
  "agents": {
    "security-scanner": { "name": "Scanner de Sécurité" },
    "code-formatter": { "name": "Formateur de Code" },
    "test-generator": { "name": "Générateur de Tests" }
  }
}
```

## Compatibilité

### Fournisseurs

Les groupes de diffusion fonctionnent actuellement avec :

- ✅ WhatsApp (implémenté)
- 🚧 Telegram (prévu)
- 🚧 Discord (prévu)
- 🚧 Slack (prévu)

## Voir aussi

- [Configuration multi-agent](/fr-FR/tools/multi-agent-sandbox-tools)
- [Configuration de routage](/fr-FR/channels/channel-routing)
- [Gestion de session](/fr-FR/concepts/sessions)
