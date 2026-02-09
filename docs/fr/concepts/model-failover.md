---
summary: "Comment OpenClaw fait tourner les profils d’authentification et bascule entre les modeles"
read_when:
  - Diagnostiquer la rotation des profils d’authentification, les delais de refroidissement ou le comportement de bascule des modeles
  - Mettre a jour les regles de bascule pour les profils d’authentification ou les modeles
title: "Bascule de modele"
---

# Bascule de modele

OpenClaw gere les échecs en deux etapes :

1. **Rotation des profils d’authentification** au sein du fournisseur courant.
2. **Bascule de modele** vers le modele suivant dans `agents.defaults.model.fallbacks`.

Ce document explique les regles d’execution et les donnees qui les sous‑tendent.

## Stockage des identifiants (cles + OAuth)

OpenClaw utilise des **profils d’authentification** a la fois pour les cles API et les jetons OAuth.

- Les secrets se trouvent dans `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (heritage : `~/.openclaw/agent/auth-profiles.json`).
- Les configurations `auth.profiles` / `auth.order` sont **uniquement des metadonnees et du routage** (aucun secret).
- Fichier OAuth historique uniquement pour l’import : `~/.openclaw/credentials/oauth.json` (importe dans `auth-profiles.json` a la premiere utilisation).

Plus de details : [/concepts/oauth](/concepts/oauth)

Types d’identifiants :

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` pour certains fournisseurs)

## Identifiants de profil

Les connexions OAuth creent des profils distincts afin que plusieurs comptes puissent coexister.

- Par defaut : `provider:default` lorsqu’aucun e‑mail n’est disponible.
- OAuth avec e‑mail : `provider:<email>` (par exemple `google-antigravity:user@gmail.com`).

Les profils se trouvent dans `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` sous `profiles`.

## Ordre de rotation

Lorsqu’un fournisseur possede plusieurs profils, OpenClaw choisit un ordre comme suit :

1. **Configuration explicite** : `auth.order[provider]` (si defini).
2. **Profils configures** : `auth.profiles` filtres par fournisseur.
3. **Profils stockes** : entrees dans `auth-profiles.json` pour le fournisseur.

Si aucun ordre explicite n’est configure, OpenClaw utilise un ordre en round‑robin :

- **Cle primaire :** type de profil (**OAuth avant les cles API**).
- **Cle secondaire :** `usageStats.lastUsed` (le plus ancien en premier, au sein de chaque type).
- Les **profils en cooldown ou desactives** sont deplaces a la fin, classes par date d’expiration la plus proche.

### Adhesion de session (favorable au cache)

OpenClaw **epingle le profil d’authentification choisi par session** afin de maintenir les caches du fournisseur.
Il **ne fait pas de rotation a chaque requete**. Le profil epingle est reutilise jusqu’a ce que :

- la session soit reinitialisee (`/new` / `/reset`)
- une compaction se termine (le compteur de compaction incremente)
- le profil passe en cooldown ou est desactive

La selection manuelle via `/model …@<profileId>` definit une **priorite utilisateur** pour cette session
et n’est pas soumise a une rotation automatique jusqu’au demarrage d’une nouvelle session.

Les profils auto‑epingles (selectionnes par le routeur de session) sont traites comme une **preference** :
ils sont essayes en premier, mais OpenClaw peut basculer vers un autre profil en cas de limites de debit ou de timeouts.
Les profils epingles par l’utilisateur restent verrouilles sur ce profil ; s’il echoue et que des bascules de modele
sont configurees, OpenClaw passe au modele suivant au lieu de changer de profil.

### Pourquoi OAuth peut « sembler perdu »

Si vous disposez a la fois d’un profil OAuth et d’un profil a cle API pour le meme fournisseur, le round‑robin peut alterner entre eux d’un message a l’autre, sauf s’ils sont epingles. Pour forcer un profil unique :

- Epinglez‑le avec `auth.order[provider] = ["provider:profileId"]`, ou
- Utilisez une priorite par session via `/model …` avec une priorite de profil (lorsque votre interface UI/canal de chat le prend en charge).

## Cooldowns

Lorsqu’un profil echoue en raison d’erreurs d’authentification ou de limites de debit (ou d’un timeout qui ressemble
a une limitation de debit), OpenClaw le place en cooldown et passe au profil suivant.
Les erreurs de format ou de requete invalide (par exemple des échecs de validation d’identifiant d’appel d’outil Cloud Code Assist)
sont considerees comme justifiant une bascule et utilisent les memes cooldowns.

Les cooldowns utilisent un backoff exponentiel :

- 1 minute
- 5 minutes
- 25 minutes
- 1 heure (plafond)

L’etat est stocke dans `auth-profiles.json` sous `usageStats` :

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

## Desactivations de facturation

Les échecs de facturation ou de credit (par exemple « credits insuffisants » / « solde de credit trop bas ») sont consideres comme justifiant une bascule, mais ils ne sont generalement pas transitoires. Au lieu d’un court cooldown, OpenClaw marque le profil comme **desactive** (avec un backoff plus long) et passe au profil ou au fournisseur suivant.

L’etat est stocke dans `auth-profiles.json` :

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

Équivalent en variable d’environnement :

- Le backoff de facturation commence a **5 heures**, double a chaque echec de facturation et est plafonne a **24 heures**.
- Les compteurs de backoff sont reinitialises si le profil n’a pas echoue pendant **24 heures** (configurable).

## Bascule de modele

Si tous les profils d’un fournisseur echouent, OpenClaw passe au modele suivant dans
`agents.defaults.model.fallbacks`. Cela s’applique aux échecs d’authentification, aux limites de debit et
aux timeouts ayant epuise la rotation des profils (les autres erreurs n’avancent pas la bascule).

Lorsqu’une execution demarre avec une priorite de modele (hooks ou CLI), les bascules se terminent tout de meme a
`agents.defaults.model.primary` apres avoir essaye toutes les bascules configurees.

## Configuration associee

Voir la [Configuration du Gateway (passerelle)](/gateway/configuration) pour :

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- Routage `agents.defaults.imageModel`

Voir [Modeles](/concepts/models) pour une vue d’ensemble plus large de la selection des modeles et de la bascule.
