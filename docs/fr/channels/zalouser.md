---
summary: "Prise en charge des comptes personnels Zalo via zca-cli (connexion par QR), fonctionnalites et configuration"
read_when:
  - Configuration de Zalo Personal pour OpenClaw
  - Depannage de la connexion ou du flux de messages Zalo Personal
title: "Zalo Personal"
---

# Zalo Personal (non officiel)

Statut : experimental. Cette integration automatise un **compte Zalo personnel** via `zca-cli`.

> **Avertissement :** Il s’agit d’une integration non officielle et elle peut entrainer une suspension ou un bannissement du compte. Utilisez a vos propres risques.

## Plugin requis

Zalo Personal est fourni sous forme de plugin et n’est pas inclus dans l’installation principale.

- Installer via la CLI : `openclaw plugins install @openclaw/zalouser`
- Ou depuis un checkout du code source : `openclaw plugins install ./extensions/zalouser`
- Details : [Plugins](/plugin)

## Prerequis : zca-cli

La machine Gateway (passerelle) doit disposer du binaire `zca` disponible dans `PATH`.

- Verifier : `zca --version`
- Si absent, installez zca-cli (voir `extensions/zalouser/README.md` ou la documentation amont de zca-cli).

## Configuration rapide (debutant)

1. Installez le plugin (voir ci-dessus).
2. Connectez-vous (QR, sur la machine Gateway) :
   - `openclaw channels login --channel zalouser`
   - Scannez le code QR affiche dans le terminal avec l’application mobile Zalo.
3. Activez le canal :

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

4. Redemarrez la Gateway (passerelle) (ou terminez la prise en main).
5. Accès DM par défaut à l'appairage ; approuve le code d'appairage au premier contact.

## De quoi s’agit-il

- Utilise `zca listen` pour recevoir les messages entrants.
- Utilise `zca msg ...` pour envoyer des reponses (texte/media/lien).
- Concu pour des cas d’usage « compte personnel » lorsque l’API Zalo Bot n’est pas disponible.

## Nommer

L’identifiant du canal est `zalouser` afin d’indiquer explicitement qu’il automatise un **compte utilisateur Zalo personnel** (non officiel). Nous reservons `zalo` pour une eventuelle future integration officielle de l’API Zalo.

## Trouver les IDs (annuaire)

Utilisez la CLI d’annuaire pour decouvrir les pairs/groupes et leurs IDs :

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## Limites

- Les messages sortants sont decoupes en blocs d’environ 2000 caracteres (limites du client Zalo).
- Le streaming est bloque par defaut.

## Contrôle d'accès (DMs)

`channels.zalouser.dmPolicy` prend en charge : `pairing | allowlist | open | disabled` (par defaut : `pairing`).
`channels.zalouser.allowFrom` accepte des IDs ou des noms d’utilisateurs. L’assistant resout les noms en IDs via `zca friend find` lorsque disponible.

Approuver via :

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## Acces aux groupes (optionnel)

- Par defaut : `channels.zalouser.groupPolicy = "open"` (groupes autorises). Utilisez `channels.defaults.groupPolicy` pour remplacer le defaut lorsqu’il n’est pas defini.
- Restreindre a une liste d’autorisation avec :
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (les cles sont des IDs ou des noms de groupes)
- Bloquer tous les groupes : `channels.zalouser.groupPolicy = "disabled"`.
- L’assistant de configuration peut proposer des listes d’autorisation de groupes.
- Au demarrage, OpenClaw resout les noms de groupes/utilisateurs des listes d’autorisation en IDs et consigne le mapping ; les entrees non resolues sont conservees telles quelles.

Exemple :

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## Multi-compte

Les comptes correspondent a des profils zca. Exemple :

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## Problemes courants

**`zca` introuvable :**

- Installez zca-cli et assurez-vous qu’il est present dans `PATH` pour le processus Gateway (passerelle).

**La connexion ne colle pas:**

- `openclaw channels status --probe`
- Reconnexion : `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
