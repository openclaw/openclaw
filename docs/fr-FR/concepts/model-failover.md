---
summary: "Comment OpenClaw fait tourner les profils d'authentification et bascule sur les modèles"
read_when:
  - Diagnostiquer la rotation de profil d'authentification, les cooldowns ou le comportement de basculement de modèle
  - Mettre à jour les règles de basculement pour les profils d'authentification ou les modèles
title: "Basculement de modèle"
---

# Basculement de modèle

OpenClaw gère les échecs en deux étapes :

1. **Rotation de profil d'authentification** au sein du fournisseur actuel.
2. **Basculement de modèle** vers le prochain modèle dans `agents.defaults.model.fallbacks`.

Ce document explique les règles d'exécution et les données qui les soutiennent.

## Stockage d'authentification (clés + OAuth)

OpenClaw utilise des **profils d'authentification** pour les clés API et les jetons OAuth.

- Les secrets vivent dans `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (hérité : `~/.openclaw/agent/auth-profiles.json`).
- La config `auth.profiles` / `auth.order` sont **métadonnées + routage uniquement** (pas de secrets).
- Fichier OAuth hérité import uniquement : `~/.openclaw/credentials/oauth.json` (importé dans `auth-profiles.json` à la première utilisation).

Plus de détails : [/concepts/oauth](/fr-FR/concepts/oauth)

Types d'identifiants :

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` pour certains fournisseurs)

## IDs de profil

Les connexions OAuth créent des profils distincts pour que plusieurs comptes puissent coexister.

- Par défaut : `provider:default` quand aucun email n'est disponible.
- OAuth avec email : `provider:<email>` (par exemple `google-antigravity:user@gmail.com`).

Les profils vivent dans `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` sous `profiles`.

## Ordre de rotation

Quand un fournisseur a plusieurs profils, OpenClaw choisit un ordre comme ceci :

1. **Config explicite** : `auth.order[provider]` (si défini).
2. **Profils configurés** : `auth.profiles` filtrés par fournisseur.
3. **Profils stockés** : entrées dans `auth-profiles.json` pour le fournisseur.

Si aucun ordre explicite n'est configuré, OpenClaw utilise un ordre round-robin :

- **Clé primaire :** type de profil (**OAuth avant clés API**).
- **Clé secondaire :** `usageStats.lastUsed` (le plus ancien en premier, dans chaque type).
- **Profils en cooldown/désactivés** sont déplacés à la fin, ordonnés par expiration la plus proche.

### Adhérence de session (compatible cache)

OpenClaw **épingle le profil d'authentification choisi par session** pour garder les caches de fournisseur chauds.
Il ne **fait pas** de rotation à chaque requête. Le profil épinglé est réutilisé jusqu'à ce que :

- la session soit réinitialisée (`/new` / `/reset`)
- une compaction se termine (le compte de compaction s'incrémente)
- le profil soit en cooldown/désactivé

La sélection manuelle via `/model …@<profileId>` définit un **remplacement utilisateur** pour cette session
et n'est pas auto-rotationnée jusqu'à ce qu'une nouvelle session démarre.

Les profils auto-épinglés (sélectionnés par le routeur de session) sont traités comme une **préférence** :
ils sont essayés en premier, mais OpenClaw peut faire tourner vers un autre profil sur les limites de taux/timeouts.
Les profils épinglés par l'utilisateur restent verrouillés sur ce profil ; s'il échoue et que des basculements de modèle
sont configurés, OpenClaw passe au modèle suivant au lieu de changer de profils.

### Pourquoi OAuth peut "sembler perdu"

Si vous avez à la fois un profil OAuth et un profil de clé API pour le même fournisseur, le round-robin peut basculer entre eux sur les messages sauf s'ils sont épinglés. Pour forcer un seul profil :

- Épinglez avec `auth.order[provider] = ["provider:profileId"]`, ou
- Utilisez un remplacement par session via `/model …` avec un remplacement de profil (quand supporté par votre UI/surface de chat).

## Cooldowns

Quand un profil échoue en raison d'erreurs d'authentification/limite de taux (ou un timeout qui ressemble
à une limitation de taux), OpenClaw le marque en cooldown et passe au profil suivant.
Les erreurs de format/requête invalide (par exemple échecs de validation d'ID d'appel d'outil Cloud Code Assist) sont traitées comme dignes de basculement et utilisent les mêmes cooldowns.

Les cooldowns utilisent un backoff exponentiel :

- 1 minute
- 5 minutes
- 25 minutes
- 1 heure (plafond)

L'état est stocké dans `auth-profiles.json` sous `usageStats` :

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

## Désactivations de facturation

Les échecs de facturation/crédit (par exemple "crédits insuffisants" / "solde de crédit trop bas") sont traités comme dignes de basculement, mais ils ne sont généralement pas transitoires. Au lieu d'un cooldown court, OpenClaw marque le profil comme **désactivé** (avec un backoff plus long) et fait tourner vers le profil/fournisseur suivant.

L'état est stocké dans `auth-profiles.json` :

```json
{
  "usageStats": {
    "provider:profile": {
      "disabledUntil": 1736178000000,
      "disabledReason": "billing"
    }
  }
}
```

Valeurs par défaut :

- Le backoff de facturation commence à **5 heures**, double par échec de facturation, et plafonne à **24 heures**.
- Les compteurs de backoff se réinitialisent si le profil n'a pas échoué pendant **24 heures** (configurable).

## Basculement vers un autre modèle

Si tous les profils d'un fournisseur échouent, OpenClaw passe au modèle suivant dans
`agents.defaults.model.fallbacks`. Cela s'applique aux échecs d'authentification, limites de taux et
timeouts qui ont épuisé la rotation de profils (les autres erreurs ne font pas avancer le basculement).

Quand une exécution démarre avec un remplacement de modèle (hooks ou CLI), les basculements finissent toujours à
`agents.defaults.model.primary` après avoir essayé tous basculements configurés.

## Config associée

Voir [Configuration de passerelle](/fr-FR/gateway/configuration) pour :

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- Routage `agents.defaults.imageModel`

Voir [Modèles](/fr-FR/concepts/models) pour la vue d'ensemble plus large de sélection de modèle et de basculement.
