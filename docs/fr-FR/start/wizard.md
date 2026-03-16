---
summary: "Assistant d'intégration CLI : configuration guidée pour la passerelle, l'espace de travail, les canaux et les compétences"
read_when:
  - Exécution ou configuration de l'assistant d'intégration
  - Configuration d'une nouvelle machine
title: "Assistant d'intégration (CLI)"
sidebarTitle: "Intégration : CLI"
---

# Assistant d'intégration (CLI)

L'assistant d'intégration est la façon **recommandée** de configurer OpenClaw sur macOS, Linux ou Windows (via WSL2 ; fortement recommandé).
Il configure une passerelle locale ou une connexion de passerelle distante, plus les canaux, les compétences et les valeurs par défaut de l'espace de travail en un flux guidé.

```bash
openclaw onboard
```

<Info>
Premier chat le plus rapide : ouvrez l'interface de contrôle (aucune configuration de canal nécessaire). Exécutez
`openclaw dashboard` et discutez dans le navigateur. Documentation : [Tableau de bord](/fr-FR/web/dashboard).
</Info>

Pour reconfigurer plus tard :

```bash
openclaw configure
openclaw agents add <nom>
```

<Note>
`--json` n'implique pas le mode non interactif. Pour les scripts, utilisez `--non-interactive`.
</Note>

<Tip>
Recommandé : configurez une clé API Brave Search pour que l'agent puisse utiliser `web_search`
(`web_fetch` fonctionne sans clé). Chemin le plus simple : `openclaw configure --section web`
qui stocke `tools.web.search.apiKey`. Documentation : [Outils web](/fr-FR/tools/web).
</Tip>

## Démarrage rapide vs Avancé

L'assistant commence par **Démarrage rapide** (valeurs par défaut) vs **Avancé** (contrôle total).

<Tabs>
  <Tab title="Démarrage rapide (valeurs par défaut)">
    - Passerelle locale (loopback)
    - Espace de travail par défaut (ou espace de travail existant)
    - Port de passerelle **18789**
    - Authentification de passerelle **Token** (auto-généré, même sur loopback)
    - Exposition Tailscale **Désactivée**
    - Les DM Telegram + WhatsApp utilisent par défaut la **liste d'autorisation** (on vous demandera votre numéro de téléphone)
  </Tab>
  <Tab title="Avancé (contrôle total)">
    - Expose chaque étape (mode, espace de travail, passerelle, canaux, démon, compétences).
  </Tab>
</Tabs>

## Ce que configure l'assistant

Le **mode local (par défaut)** vous guide à travers ces étapes :

1. **Modèle/Authentification** — Clé API Anthropic (recommandée), OpenAI ou fournisseur personnalisé
   (compatible OpenAI, compatible Anthropic ou détection automatique inconnue). Choisissez un modèle par défaut.
2. **Espace de travail** — Emplacement des fichiers d'agent (par défaut `~/.openclaw/workspace`). Initialise les fichiers d'initialisation.
3. **Passerelle** — Port, adresse de liaison, mode d'authentification, exposition Tailscale.
4. **Canaux** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles ou iMessage.
5. **Démon** — Installe un LaunchAgent (macOS) ou une unité utilisateur systemd (Linux/WSL2).
6. **Vérification de santé** — Démarre la passerelle et vérifie qu'elle fonctionne.
7. **Compétences** — Installe les compétences recommandées et les dépendances optionnelles.

<Note>
Réexécuter l'assistant ne **supprime** rien sauf si vous choisissez explicitement **Réinitialiser** (ou passez `--reset`).
Si la configuration est invalide ou contient des clés héritées, l'assistant vous demande d'exécuter d'abord `openclaw doctor`.
</Note>

Le **mode distant** configure uniquement le client local pour se connecter à une passerelle ailleurs.
Il n'installe **pas** ni ne modifie quoi que ce soit sur l'hôte distant.

## Ajouter un autre agent

Utilisez `openclaw agents add <nom>` pour créer un agent séparé avec son propre espace de travail, ses sessions et ses profils d'authentification. L'exécuter sans `--workspace` lance l'assistant.

Ce qu'il définit :

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Notes :

- Les espaces de travail par défaut suivent `~/.openclaw/workspace-<agentId>`.
- Ajoutez des `bindings` pour acheminer les messages entrants (l'assistant peut le faire).
- Indicateurs non interactifs : `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Référence complète

Pour des détails étape par étape, des scripts non interactifs, la configuration Signal, l'API RPC et une liste complète des champs de configuration que l'assistant écrit, consultez la [Référence de l'assistant](/fr-FR/reference/wizard).

## Documentation connexe

- Référence de commande CLI : [`openclaw onboard`](/fr-FR/cli/onboard)
- Vue d'ensemble de l'intégration : [Vue d'ensemble de l'intégration](/fr-FR/start/onboarding-overview)
- Intégration de l'application macOS : [Intégration](/fr-FR/start/onboarding)
- Rituel de première exécution de l'agent : [Initialisation de l'agent](/fr-FR/start/bootstrapping)
