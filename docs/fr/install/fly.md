---
title: Fly.io
description: Deploy OpenClaw on Fly.io
---

# Déploiement Fly.io

**Objectif :** OpenClaw Gateway (passerelle) exécuté sur une machine [Fly.io](https://fly.io) avec stockage persistant, HTTPS automatique et accès Discord/canal.

## Ce dont vous avez besoin

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) installé
- Compte Fly.io (le niveau gratuit fonctionne)
- Authentification du modèle : clé API Anthropic (ou autres clés de fournisseur)
- Identifiants de canal : jeton de bot Discord, jeton Telegram, etc.

## Parcours rapide pour débutants

1. Cloner le dépôt → personnaliser `fly.toml`
2. Créer l’application + le volume → définir les secrets
3. Déployer avec `fly deploy`
4. Se connecter en SSH pour créer la configuration ou utiliser l’interface de contrôle

## 1) Créer l’application Fly

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**Astuce :** Choisissez une région proche de vous. Options courantes : `lhr` (Londres), `iad` (Virginie), `sjc` (San Jose).

## 2. Configurer fly.toml

Modifiez `fly.toml` pour correspondre au nom de votre application et à vos exigences.

**Note de sécurité :** La configuration par défaut expose une URL publique. Pour un déploiement renforcé sans IP publique, voir [Déploiement privé](#private-deployment-hardened) ou utiliser `fly.private.toml`.

```toml
app = "my-openclaw"  # Your app name
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

| Paramètre                      | Pourquoi                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `--bind lan`                   | Se lie à `0.0.0.0` afin que le proxy Fly puisse atteindre la passerelle                               |
| `--allow-unconfigured`         | Démarre sans fichier de configuration (vous en créerez un ensuite)                 |
| `internal_port = 3000`         | Doit correspondre à `--port 3000` (ou `OPENCLAW_GATEWAY_PORT`) pour les checks Fly |
| `memory = "2048mb"`            | 512 Mo est trop faible ; 2 Go recommandés                                                             |
| `OPENCLAW_STATE_DIR = "/data"` | Persiste l’état sur le volume                                                                         |

## 3. Définir les secrets

```bash
# Required: Gateway token (for non-loopback binding)
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

# Model provider API keys
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# Optional: Other providers
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=...

# Channel tokens
fly secrets set DISCORD_BOT_TOKEN=MTQ...
```

**Notes :**

- Les liaisons non loopback (`--bind lan`) nécessitent `OPENCLAW_GATEWAY_TOKEN` pour la sécurité.
- Traitez ces jetons comme des mots de passe.
- **Privilégiez les variables d’environnement plutôt que le fichier de configuration** pour toutes les clés API et les jetons. Cela évite d’exposer ou de journaliser accidentellement des secrets dans `openclaw.json`.

## 4. Déployer

```bash
fly deploy
```

Le premier déploiement construit l’image Docker (~2–3 minutes). Les déploiements suivants sont plus rapides.

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

## 5. Créer le fichier de configuration

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

**Remarque :** Avec `OPENCLAW_STATE_DIR=/data`, le chemin de configuration est `/data/openclaw.json`.

**Remarque :** Le jeton Discord peut provenir de l’une des sources suivantes :

- Variable d’environnement : `DISCORD_BOT_TOKEN` (recommandé pour les secrets)
- Fichier de configuration : `channels.discord.token`

Si vous utilisez une variable d’environnement, inutile d’ajouter le jeton à la configuration. La passerelle lit automatiquement `DISCORD_BOT_TOKEN`.

Redémarrez pour appliquer :

```bash
exit
fly machine restart <machine-id>
```

## 6. Accéder à la passerelle

### Interface de contrôle

Ouvrez dans le navigateur :

```bash
fly open
```

Ou visitez `https://my-openclaw.fly.dev/`

Collez votre jeton de passerelle (celui de `OPENCLAW_GATEWAY_TOKEN`) pour vous authentifier.

### Journaux

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### Console SSH

```bash
fly ssh console
```

## Problemes courants

### « App is not listening on expected address »

La passerelle se lie à `127.0.0.1` au lieu de `0.0.0.0`.

**Correctif :** Ajoutez `--bind lan` à votre commande de processus dans `fly.toml`.

### Échecs des checks de santé / connexion refusée

Fly ne peut pas atteindre la passerelle sur le port configuré.

**Correctif :** Assurez-vous que `internal_port` correspond au port de la passerelle (définissez `--port 3000` ou `OPENCLAW_GATEWAY_PORT=3000`).

### OOM / Problèmes de mémoire

Le conteneur redémarre sans cesse ou est tué. Signes : `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration` ou redémarrages silencieux.

**Correctif :** Augmentez la mémoire dans `fly.toml` :

```toml
[[vm]]
  memory = "2048mb"
```

Ou mettez à jour une machine existante :

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**Remarque :** 512 Mo est trop faible. 1 Go peut fonctionner mais peut provoquer des OOM sous charge ou avec des journaux verbeux. **2 Go est recommandé.**

### Problèmes de verrouillage de la passerelle

La passerelle refuse de démarrer avec des erreurs « already running ».

Cela se produit lorsque le conteneur redémarre mais que le fichier de verrou PID persiste sur le volume.

**Correctif :** Supprimez le fichier de verrouillage :

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

Le fichier de verrouillage se trouve à `/data/gateway.*.lock` (pas dans un sous-répertoire).

### La configuration n’est pas lue

Si vous utilisez `--allow-unconfigured`, la passerelle crée une configuration minimale. Votre configuration personnalisée à `/data/openclaw.json` doit être lue au redémarrage.

Vérifiez que la configuration existe :

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### Écriture de la configuration via SSH

La commande `fly ssh console -C` ne prend pas en charge la redirection du shell. Pour écrire un fichier de configuration :

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**Remarque :** `fly sftp` peut échouer si le fichier existe déjà. Supprimez-le d’abord :

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### L’état ne persiste pas

Si vous perdez des identifiants ou des sessions après un redémarrage, le répertoire d’état écrit dans le système de fichiers du conteneur.

**Correctif :** Assurez-vous que `OPENCLAW_STATE_DIR=/data` est défini dans `fly.toml` et redéployez.

## Mises à jour

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### Mise à jour de la commande de la machine

Si vous devez modifier la commande de démarrage sans redéploiement complet :

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**Remarque :** Après `fly deploy`, la commande de la machine peut revenir à celle définie dans `fly.toml`. Si vous avez effectué des modifications manuelles, réappliquez-les après le déploiement.

## Déploiement privé (renforcé)

Par défaut, Fly alloue des IP publiques, rendant votre passerelle accessible à `https://your-app.fly.dev`. C’est pratique, mais cela signifie que votre déploiement est découvrable par des scanners Internet (Shodan, Censys, etc.).

Pour un déploiement renforcé **sans exposition publique**, utilisez le modèle privé.

### Quand utiliser le déploiement privé

- Vous effectuez uniquement des appels/messages **sortants** (pas de webhooks entrants)
- Vous utilisez des tunnels **ngrok ou Tailscale** pour les rappels de webhook
- Vous accédez à la passerelle via **SSH, proxy ou WireGuard** plutôt que via le navigateur
- Vous souhaitez que le déploiement soit **caché des scanners Internet**

### Configuration

Utilisez `fly.private.toml` au lieu de la configuration standard :

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

Ou convertissez un déploiement existant :

```bash
# List current IPs
fly ips list -a my-openclaw

# Release public IPs
fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# Switch to private config so future deploys don't re-allocate public IPs
# (remove [http_service] or deploy with the private template)
fly deploy -c fly.private.toml

# Allocate private-only IPv6
fly ips allocate-v6 --private -a my-openclaw
```

Après cela, `fly ips list` ne devrait afficher qu’une IP de type `private` :

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### Accéder à un déploiement privé

Comme il n’y a pas d’URL publique, utilisez l’une des méthodes suivantes :

**Option 1 : Proxy local (le plus simple)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**Option 2 : VPN WireGuard**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**Option 3 : SSH uniquement**

```bash
fly ssh console -a my-openclaw
```

### Webhooks avec déploiement privé

Si vous avez besoin de rappels de webhook (Twilio, Telnyx, etc.) sans exposition publique :

1. **Tunnel ngrok** — Exécutez ngrok dans le conteneur ou comme sidecar
2. **Tailscale Funnel** — Exposez des chemins spécifiques via Tailscale
3. **Sortant uniquement** — Certains fournisseurs (Twilio) fonctionnent très bien pour les appels sortants sans webhooks

Exemple de configuration d’appel vocal avec ngrok :

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

Le tunnel ngrok s’exécute dans le conteneur et fournit une URL de webhook publique sans exposer l’application Fly elle-même. Définissez `webhookSecurity.allowedHosts` sur le nom d’hôte public du tunnel afin que les en-têtes d’hôte transférés soient acceptés.

### Avantages de sécurité

| Aspect                   | Public      | Privé      |
| ------------------------ | ----------- | ---------- |
| Scanners Internet        | Découvrable | Hidden     |
| Attaques directes        | Possibles   | Bloquées   |
| Accès à l’UI de contrôle | Navigateur  | Proxy/VPN  |
| Livraison des webhooks   | Directe     | Via tunnel |

## Notes

- Fly.io utilise une **architecture x86** (pas ARM)
- Le Dockerfile est compatible avec les deux architectures
- Pour l’onboarding WhatsApp/Telegram, utilisez `fly ssh console`
- Les données persistantes se trouvent sur le volume à `/data`
- Signal nécessite Java + signal-cli ; utilisez une image personnalisée et maintenez la mémoire à 2 Go+.

## Coût

Avec la configuration recommandée (`shared-cpu-2x`, 2 Go de RAM) :

- ~10–15 $/mois selon l’utilisation
- Le niveau gratuit inclut une certaine allocation

Voir [les tarifs Fly.io](https://fly.io/docs/about/pricing/) pour plus de détails.
