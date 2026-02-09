---
summary: "Comment OpenClaw construit le contexte de prompt et rapporte l’utilisation des tokens et les coûts"
read_when:
  - Expliquer l’utilisation des tokens, les coûts ou les fenêtres de contexte
  - Déboguer la croissance du contexte ou le comportement de compactage
title: "Utilisation des tokens et coûts"
---

# Utilisation des tokens et coûts

OpenClaw suit les **tokens**, pas les caractères. Les tokens sont spécifiques au modèle, mais la plupart des modèles de type OpenAI font en moyenne ~4 caractères par token pour le texte anglais.

## Comment le prompt système est construit

OpenClaw assemble son propre prompt système à chaque exécution. Il inclut :

- Liste des outils + descriptions courtes
- Liste des Skills (uniquement les métadonnées ; les instructions sont chargées à la demande avec `read`)
- Instructions d’auto‑mise à jour
- Workspace + fichiers de bootstrap (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` lorsqu’ils sont nouveaux). Les fichiers volumineux sont tronqués par `agents.defaults.bootstrapMaxChars` (par défaut : 20000).
- Heure (UTC + fuseau horaire de l’utilisateur)
- Balises de réponse + comportement de heartbeat
- Métadonnées d’exécution (hôte/OS/modèle/réflexion)

Voir le détail complet dans [System Prompt](/concepts/system-prompt).

## Ce qui compte dans la fenêtre de contexte

Tout ce que le modèle reçoit compte dans la limite de contexte :

- Prompt système (toutes les sections listées ci‑dessus)
- Historique de conversation (messages utilisateur + assistant)
- Appels d’outils et résultats d’outils
- Pièces jointes/transcriptions (images, audio, fichiers)
- Résumés de compactage et artefacts d’élagage
- Enveloppes du fournisseur ou en‑têtes de sécurité (non visibles, mais comptabilisés)

Pour une ventilation pratique (par fichier injecté, outils, Skills et taille du prompt système), utilisez `/context list` ou `/context detail`. Voir [Context](/concepts/context).

## Comment voir l’utilisation actuelle des tokens

Utilisez ceci dans le chat :

- `/status` → **carte d’état riche en émojis** avec le modèle de la session, l’utilisation du contexte,
  les tokens d’entrée/sortie de la dernière réponse et le **coût estimé** (clé API uniquement).
- `/usage off|tokens|full` → ajoute un **pied de page d’utilisation par réponse** à chaque réponse.
  - Persiste par session (stocké comme `responseUsage`).
  - L’authentification OAuth **masque le coût** (tokens uniquement).
- `/usage cost` → affiche un récapitulatif local des coûts à partir des journaux de session OpenClaw.

Autres interfaces :

- **TUI/Web TUI :** `/status` + `/usage` sont pris en charge.
- **CLI :** `openclaw status --usage` et `openclaw channels list` affichent
  les fenêtres de quotas du fournisseur (pas les coûts par réponse).

## Estimation des coûts (lorsqu’affichée)

Les coûts sont estimés à partir de la configuration de tarification de votre modèle :

```
models.providers.<provider>.models[].cost
```

Il s’agit de **USD par 1M de tokens** pour `input`, `output`, `cacheRead` et
`cacheWrite`. Si la tarification est absente, OpenClaw affiche uniquement les tokens. Les jetons OAuth
n’affichent jamais le coût en dollars.

## Impact du TTL du cache et de l’élagage

La mise en cache des prompts par le fournisseur ne s’applique que dans la fenêtre de TTL du cache. OpenClaw peut
exécuter en option un **élagage cache‑ttl** : il élague la session une fois le TTL du cache expiré, puis réinitialise
la fenêtre de cache afin que les requêtes suivantes puissent réutiliser le contexte fraîchement mis en cache au lieu
de re‑mettre en cache l’historique complet. Cela maintient des coûts d’écriture du cache plus faibles lorsqu’une session
reste inactive au‑delà du TTL.

Configurez‑le dans la [configuration de la Gateway (passerelle)](/gateway/configuration) et consultez les
détails de comportement dans [Session pruning](/concepts/session-pruning).

Le heartbeat peut garder le cache **chaud** à travers des périodes d’inactivité. Si le TTL de cache de votre modèle
est `1h`, définir l’intervalle de heartbeat juste en dessous (par ex., `55m`) peut éviter
de re‑mettre en cache le prompt complet, réduisant les coûts d’écriture du cache.

Pour la tarification de l’API Anthropic, les lectures de cache sont nettement moins chères que les tokens d’entrée,
tandis que les écritures de cache sont facturées avec un multiplicateur plus élevé. Consultez la tarification la plus
récente du cache de prompts d’Anthropic pour les taux et multiplicateurs de TTL :
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### Exemple : garder un cache d’1 h chaud avec le heartbeat

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

## Conseils pour réduire la pression des tokens

- Utilisez `/compact` pour résumer les longues sessions.
- Réduisez les sorties d’outils volumineuses dans vos workflows.
- Gardez des descriptions de Skills courtes (la liste des Skills est injectée dans le prompt).
- Préférez des modèles plus petits pour un travail verbeux et exploratoire.

Voir [Skills](/tools/skills) pour la formule exacte de surcharge de la liste des Skills.
