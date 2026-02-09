---
summary: "Connexions manuelles pour l’automatisation du navigateur + publication sur X/Twitter"
read_when:
  - Vous devez vous connecter à des sites pour l’automatisation du navigateur
  - Vous souhaitez publier des mises à jour sur X/Twitter
title: "Connexion au navigateur"
---

# Connexion au navigateur + publication sur X/Twitter

## Connexion manuelle (recommandée)

Lorsqu’un site exige une connexion, **connectez‑vous manuellement** dans le profil de navigateur **hôte** (le navigateur OpenClaw).

Ne donnez **pas** vos identifiants au modèle. Les connexions automatisées déclenchent souvent des défenses anti‑bot et peuvent verrouiller le compte.

Retour à la documentation principale du navigateur : [Browser](/tools/browser).

## Quel profil Chrome est utilisé ?

OpenClaw contrôle un **profil Chrome dédié** (nommé `openclaw`, interface teintée d’orange). Il est distinct de votre profil de navigation quotidien.

Deux moyens simples d’y accéder :

1. **Demandez à l’agent d’ouvrir le navigateur**, puis connectez‑vous vous‑même.
2. **Ouvrez‑le via la CLI** :

```bash
openclaw browser start
openclaw browser open https://x.com
```

Si vous avez plusieurs profils, passez `--browser-profile <name>` (la valeur par défaut est `openclaw`).

## X/Twitter : flux recommandé

- **Lire/recherche/threads:** utilise le navigateur **hôte** (connexion manuelle).
- **Publication de mises à jour :** utilisez le navigateur **hôte** (connexion manuelle).

## Sandboxing + accès au navigateur hôte

Les sessions de navigateur en sandbox sont **plus susceptibles** de déclencher la détection de bots. Pour X/Twitter (et d’autres sites stricts), privilégiez le navigateur **hôte**.

Si l’agent est en sandbox, l’outil de navigateur utilise la sandbox par défaut. Pour autoriser le contrôle de l’hôte :

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Puis ciblez le navigateur hôte :

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

Ou désactivez le sandboxing pour l’agent qui publie des mises à jour.
