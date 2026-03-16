---
title: Fly.io
description: Déployer OpenClaw sur Fly.io
---

# Déploiement sur Fly.io

**Objectif :** Passerelle OpenClaw fonctionnant sur une machine [Fly.io](https://fly.io) avec stockage persistant, HTTPS automatique et accès Discord/canaux.

## Ce dont vous avez besoin

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) installé
- Compte Fly.io (l'offre gratuite fonctionne)
- Authentification modèle : clé API Anthropic (ou autres clés de fournisseur)
- Identifiants de canaux : token de bot Discord, token Telegram, etc.

## Chemin rapide pour débutants

1. Cloner le dépôt → personnaliser `fly.toml`
2. Créer l'application + volume → définir les secrets
3. Déployer avec `fly deploy`
4. Se connecter en SSH pour créer la configuration ou utiliser l'interface de contrôle

## 1) Créer l'application Fly

```bash
# Cloner le dépôt
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Créer une nouvelle application Fly (choisissez votre propre nom)
fly apps create my-openclaw

# Créer un volume persistant (1 Go suffit généralement)
fly volumes create openclaw_data --size 1 --region iad
```

**Astuce :** Choisissez une région proche de vous. Options courantes : `lhr` (Londres), `iad` (Virginie), `sjc` (San José).

## 2) Configurer fly.toml

Modifiez `fly.toml` pour correspondre au nom de votre application et à vos besoins.

**Note de sécurité :** La configuration par défaut expose une URL publique. Pour un déploiement renforcé sans IP publique, consultez [Déploiement privé renforcé](#déploiement-privé-renforcé) ou utilisez `fly.private.toml`.

```toml
app = "my-openclaw"  # Nom de votre application
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  OPENCLAW_PREFER_PNPM = "1"
  OPENCLAW_STATE_DIR = "/data"
  NODE_OPTIONS = "--max-old-space-size=1536"

[processes]
  app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

[[vm]]
  size = "shared-cpu-2x"
  memory = "2048mb"

[mounts]
  source = "openclaw_data"
  destination = "/data"
```

**Paramètres clés :**

| Paramètre                      | Raison                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `--bind lan`                   | Lie à `0.0.0.0` pour que le proxy Fly puisse atteindre la passerelle                  |
| `--allow-unconfigured`         | Démarre sans fichier de configuration (vous en créerez un après)                      |
| `internal_port = 3000`         | Doit correspondre à `--port 3000` (ou `OPENCLAW_GATEWAY_PORT`) pour les vérifications |
| `memory = "2048mb"`            | 512 Mo est trop petit ; 2 Go recommandé                                               |
| `OPENCLAW_STATE_DIR = "/data"` | Persiste l'état sur le volume                                                         |

## 3) Définir les secrets

```bash
# Requis : token de passerelle (pour liaison non-loopback)
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

# Clés API des fournisseurs de modèles
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# Optionnel : autres fournisseurs
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=...

# Tokens de canaux
fly secrets set DISCORD_BOT_TOKEN=MTQ...
```

**Notes :**

- Les liaisons non-loopback (`--bind lan`) nécessitent `OPENCLAW_GATEWAY_TOKEN` pour la sécurité.
- Traitez ces tokens comme des mots de passe.
- **Préférez les variables d'environnement au fichier de configuration** pour toutes les clés API et tokens. Cela évite que les secrets ne se retrouvent dans `openclaw.json` où ils pourraient être exposés ou enregistrés accidentellement.

## 4) Déployer

```bash
fly deploy
```

Le premier déploiement construit l'image Docker (~2-3 minutes). Les déploiements suivants sont plus rapides.

Après le déploiement, vérifiez :

```bash
fly status
fly logs
```

Vous devriez voir :

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5) Créer le fichier de configuration

Connectez-vous en SSH à la machine pour créer une configuration appropriée :

```bash
fly ssh console
```

Créez le répertoire et le fichier de configuration :

```bash
mkdir -p /data
cat > /data/openclaw.json << 'EOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-6",
        "fallbacks": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]
      },
      "maxConcurrent": 4
    },
    "list": [
      {
        "id": "main",
        "default": true
      }
    ]
  },
  "auth": {
    "profiles": {
      "anthropic:default": { "mode": "token", "provider": "anthropic" },
      "openai:default": { "mode": "token", "provider": "openai" }
    }
  },
  "bindings": [
    {
      "agentId": "main",
      "match": { "channel": "discord" }
    }
  ],
  "channels": {
    "discord": {
      "enabled": true,
      "groupPolicy": "allowlist",
      "guilds": {
        "YOUR_GUILD_ID": {
          "channels": { "general": { "allow": true } },
          "requireMention": false
        }
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "auto"
  },
  "meta": {
    "lastTouchedVersion": "2026.1.29"
  }
}
EOF
```

**Note :** Avec `OPENCLAW_STATE_DIR=/data`, le chemin de configuration est `/data/openclaw.json`.

**Note :** Le token Discord peut provenir soit de :

- Variable d'environnement : `DISCORD_BOT_TOKEN` (recommandé pour les secrets)
- Fichier de configuration : `channels.discord.token`

Si vous utilisez une variable d'environnement, pas besoin d'ajouter le token dans la configuration. La passerelle lit `DISCORD_BOT_TOKEN` automatiquement.

Redémarrez pour appliquer :

```bash
exit
fly machine restart <machine-id>
```

## 6) Accéder à la passerelle

### Interface de contrôle

Ouvrez dans le navigateur :

```bash
fly open
```

Ou visitez `https://my-openclaw.fly.dev/`

Collez votre token de passerelle (celui de `OPENCLAW_GATEWAY_TOKEN`) pour vous authentifier.

### Journaux

```bash
fly logs              # Journaux en direct
fly logs --no-tail    # Journaux récents
```

### Console SSH

```bash
fly ssh console
```

## Dépannage

### "App is not listening on expected address"

La passerelle se lie à `127.0.0.1` au lieu de `0.0.0.0`.

**Correction :** Ajoutez `--bind lan` à votre commande de processus dans `fly.toml`.

### Échec des vérifications de santé / connexion refusée

Fly ne peut pas atteindre la passerelle sur le port configuré.

**Correction :** Assurez-vous que `internal_port` correspond au port de la passerelle (définissez `--port 3000` ou `OPENCLAW_GATEWAY_PORT=3000`).

### OOM / Problèmes de mémoire

Le conteneur continue de redémarrer ou d'être tué. Signes : `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration`, ou redémarrages silencieux.

**Correction :** Augmentez la mémoire dans `fly.toml` :

```toml
[[vm]]
  memory = "2048mb"
```

Ou mettez à jour une machine existante :

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**Note :** 512 Mo est trop petit. 1 Go peut fonctionner mais peut manquer de mémoire sous charge ou avec journalisation verbeuse. **2 Go est recommandé.**

### Problèmes de verrou de passerelle

La passerelle refuse de démarrer avec des erreurs "already running".

Cela arrive quand le conteneur redémarre mais que le fichier de verrou PID persiste sur le volume.

**Correction :** Supprimez le fichier de verrou :

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

Le fichier de verrou est à `/data/gateway.*.lock` (pas dans un sous-répertoire).

### Configuration non lue

Si vous utilisez `--allow-unconfigured`, la passerelle crée une configuration minimale. Votre configuration personnalisée à `/data/openclaw.json` devrait être lue au redémarrage.

Vérifiez que la configuration existe :

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### Écriture de configuration via SSH

La commande `fly ssh console -C` ne supporte pas la redirection shell. Pour écrire un fichier de configuration :

```bash
# Utilisez echo + tee (pipe du local vers le distant)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Ou utilisez sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**Note :** `fly sftp` peut échouer si le fichier existe déjà. Supprimez-le d'abord :

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### État non persistant

Si vous perdez les identifiants ou sessions après un redémarrage, le répertoire d'état écrit sur le système de fichiers du conteneur.

**Correction :** Assurez-vous que `OPENCLAW_STATE_DIR=/data` est défini dans `fly.toml` et redéployez.

## Mises à jour

```bash
# Récupérer les dernières modifications
git pull

# Redéployer
fly deploy

# Vérifier la santé
fly status
fly logs
```

### Mise à jour de la commande de machine

Si vous devez changer la commande de démarrage sans redéploiement complet :

```bash
# Obtenir l'ID de la machine
fly machines list

# Mettre à jour la commande
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Ou avec augmentation de mémoire
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**Note :** Après `fly deploy`, la commande de machine peut se réinitialiser à ce qui est dans `fly.toml`. Si vous avez fait des modifications manuelles, réappliquez-les après le déploiement.

## Déploiement privé (renforcé)

Par défaut, Fly alloue des IP publiques, rendant votre passerelle accessible à `https://your-app.fly.dev`. C'est pratique mais signifie que votre déploiement est découvrable par les scanners Internet (Shodan, Censys, etc.).

Pour un déploiement renforcé avec **aucune exposition publique**, utilisez le modèle privé.

### Quand utiliser le déploiement privé

- Vous faites uniquement des appels/messages **sortants** (pas de webhooks entrants)
- Vous utilisez des tunnels **ngrok ou Tailscale** pour tout rappel webhook
- Vous accédez à la passerelle via **SSH, proxy ou WireGuard** au lieu du navigateur
- Vous voulez que le déploiement soit **masqué aux scanners Internet**

### Configuration

Utilisez `fly.private.toml` au lieu de la configuration standard :

```bash
# Déployer avec la configuration privée
fly deploy -c fly.private.toml
```

Ou convertissez un déploiement existant :

```bash
# Lister les IP actuelles
fly ips list -a my-openclaw

# Libérer les IP publiques
fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# Passer à la configuration privée pour que les futurs déploiements ne réallouent pas d'IP publiques
# (supprimer [http_service] ou déployer avec le modèle privé)
fly deploy -c fly.private.toml

# Allouer une IPv6 privée uniquement
fly ips allocate-v6 --private -a my-openclaw
```

Après cela, `fly ips list` ne devrait montrer qu'une IP de type `private` :

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### Accéder à un déploiement privé

Comme il n'y a pas d'URL publique, utilisez une de ces méthodes :

**Option 1 : Proxy local (le plus simple)**

```bash
# Transférer le port local 3000 vers l'application
fly proxy 3000:3000 -a my-openclaw

# Puis ouvrir http://localhost:3000 dans le navigateur
```

**Option 2 : VPN WireGuard**

```bash
# Créer la configuration WireGuard (une fois)
fly wireguard create

# Importer dans le client WireGuard, puis accéder via l'IPv6 interne
# Exemple : http://[fdaa:x:x:x:x::x]:3000
```

**Option 3 : SSH uniquement**

```bash
fly ssh console -a my-openclaw
```

### Webhooks avec déploiement privé

Si vous avez besoin de rappels webhook (Twilio, Telnyx, etc.) sans exposition publique :

1. **Tunnel ngrok** - Exécutez ngrok dans le conteneur ou comme sidecar
2. **Tailscale Funnel** - Exposez des chemins spécifiques via Tailscale
3. **Sortant uniquement** - Certains fournisseurs (Twilio) fonctionnent bien pour les appels sortants sans webhooks

Exemple de configuration d'appel vocal avec ngrok :

```json
{
  "plugins": {
    "entries": {
      "voice-call": {
        "enabled": true,
        "config": {
          "provider": "twilio",
          "tunnel": { "provider": "ngrok" },
          "webhookSecurity": {
            "allowedHosts": ["example.ngrok.app"]
          }
        }
      }
    }
  }
}
```

Le tunnel ngrok s'exécute dans le conteneur et fournit une URL webhook publique sans exposer l'application Fly elle-même. Définissez `webhookSecurity.allowedHosts` au nom d'hôte du tunnel public pour que les en-têtes d'hôte transférés soient acceptés.

### Avantages de sécurité

| Aspect            | Public      | Privé      |
| ----------------- | ----------- | ---------- |
| Scanners Internet | Découvrable | Masqué     |
| Attaques directes | Possibles   | Bloquées   |
| Accès interface   | Navigateur  | Proxy/VPN  |
| Livraison webhook | Direct      | Via tunnel |

## Notes

- Fly.io utilise l'**architecture x86** (pas ARM)
- Le Dockerfile est compatible avec les deux architectures
- Pour l'intégration WhatsApp/Telegram, utilisez `fly ssh console`
- Les données persistantes se trouvent sur le volume à `/data`
- Signal nécessite Java + signal-cli ; utilisez une image personnalisée et gardez la mémoire à 2 Go+.

## Coût

Avec la configuration recommandée (`shared-cpu-2x`, 2 Go RAM) :

- ~10-15 $/mois selon l'utilisation
- L'offre gratuite inclut une allocation

Voir [tarification Fly.io](https://fly.io/docs/about/pricing/) pour les détails.
