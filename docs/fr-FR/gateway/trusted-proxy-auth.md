---
summary: "Déléguer l'authentification de la passerelle à un proxy inverse de confiance (Pomerium, Caddy, nginx + OAuth)"
read_when:
  - Exécution d'OpenClaw derrière un proxy sensible à l'identité
  - Configuration de Pomerium, Caddy ou nginx avec OAuth devant OpenClaw
  - Correction des erreurs WebSocket 1008 unauthorized avec les configurations de proxy inverse
---

# Authentification par proxy de confiance

> ⚠️ **Fonctionnalité sensible en matière de sécurité.** Ce mode délègue entièrement l'authentification à votre proxy inverse. Une mauvaise configuration peut exposer votre passerelle à un accès non autorisé. Lisez attentivement cette page avant l'activation.

## Quand utiliser

Utilisez le mode d'authentification `trusted-proxy` quand :

- Vous exécutez OpenClaw derrière un **proxy sensible à l'identité** (Pomerium, Caddy + OAuth, nginx + oauth2-proxy, Traefik + forward auth)
- Votre proxy gère toute l'authentification et transmet l'identité utilisateur via des en-têtes
- Vous êtes dans un environnement Kubernetes ou conteneur où le proxy est le seul chemin vers la passerelle
- Vous rencontrez des erreurs WebSocket `1008 unauthorized` car les navigateurs ne peuvent pas passer de jetons dans les payloads WS

## Quand NE PAS utiliser

- Si votre proxy n'authentifie pas les utilisateurs (juste un terminateur TLS ou équilibreur de charge)
- S'il existe un chemin vers la passerelle qui contourne le proxy (trous de pare-feu, accès réseau interne)
- Si vous n'êtes pas sûr que votre proxy supprime/écrase correctement les en-têtes transférés
- Si vous avez seulement besoin d'un accès personnel mono-utilisateur (considérez Tailscale Serve + loopback pour une configuration plus simple)

## Comment ça fonctionne

1. Votre proxy inverse authentifie les utilisateurs (OAuth, OIDC, SAML, etc.)
2. Le proxy ajoute un en-tête avec l'identité utilisateur authentifié (ex : `x-forwarded-user: nick@example.com`)
3. OpenClaw vérifie que la requête provient d'une **IP de proxy de confiance** (configurée dans `gateway.trustedProxies`)
4. OpenClaw extrait l'identité utilisateur de l'en-tête configuré
5. Si tout est correct, la requête est autorisée

## Configuration

```json5
{
  gateway: {
    // Doit se lier à l'interface réseau (pas loopback)
    bind: "lan",

    // CRITIQUE : Ajoutez uniquement les IP de votre proxy ici
    trustedProxies: ["10.0.0.1", "172.17.0.1"],

    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        // En-tête contenant l'identité utilisateur authentifié (requis)
        userHeader: "x-forwarded-user",

        // Optionnel : en-têtes qui DOIVENT être présents (vérification proxy)
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],

        // Optionnel : restreindre à des utilisateurs spécifiques (vide = autoriser tous)
        allowUsers: ["nick@example.com", "admin@company.org"],
      },
    },
  },
}
```

### Référence de configuration

| Champ                                       | Requis | Description                                                                                          |
| ------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| `gateway.trustedProxies`                    | Oui    | Tableau d'adresses IP de proxy à faire confiance. Les requêtes d'autres IP sont rejetées.            |
| `gateway.auth.mode`                         | Oui    | Doit être `"trusted-proxy"`                                                                          |
| `gateway.auth.trustedProxy.userHeader`      | Oui    | Nom de l'en-tête contenant l'identité utilisateur authentifié                                        |
| `gateway.auth.trustedProxy.requiredHeaders` | Non    | En-têtes supplémentaires qui doivent être présents pour que la requête soit de confiance             |
| `gateway.auth.trustedProxy.allowUsers`      | Non    | Liste blanche des identités utilisateur. Vide signifie autoriser tous les utilisateurs authentifiés. |

## Exemples de configuration de proxy

### Pomerium

Pomerium transmet l'identité dans `x-pomerium-claim-email` (ou autres en-têtes de claims) et un JWT dans `x-pomerium-jwt-assertion`.

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["10.0.0.1"], // IP de Pomerium
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-pomerium-claim-email",
        requiredHeaders: ["x-pomerium-jwt-assertion"],
      },
    },
  },
}
```

Extrait de configuration Pomerium :

```yaml
routes:
  - from: https://openclaw.example.com
    to: http://openclaw-gateway:18789
    policy:
      - allow:
          or:
            - email:
                is: nick@example.com
    pass_identity_headers: true
```

### Caddy avec OAuth

Caddy avec le plugin `caddy-security` peut authentifier les utilisateurs et transmettre les en-têtes d'identité.

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["127.0.0.1"], // IP de Caddy (si sur le même hôte)
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    },
  },
}
```

Extrait de Caddyfile :

```
openclaw.example.com {
    authenticate with oauth2_provider
    authorize with policy1

    reverse_proxy openclaw:18789 {
        header_up X-Forwarded-User {http.auth.user.email}
    }
}
```

### nginx + oauth2-proxy

oauth2-proxy authentifie les utilisateurs et transmet l'identité dans `x-auth-request-email`.

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["10.0.0.1"], // IP nginx/oauth2-proxy
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-auth-request-email",
      },
    },
  },
}
```

Extrait de configuration nginx :

```nginx
location / {
    auth_request /oauth2/auth;
    auth_request_set $user $upstream_http_x_auth_request_email;

    proxy_pass http://openclaw:18789;
    proxy_set_header X-Auth-Request-Email $user;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

### Traefik avec Forward Auth

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["172.17.0.1"], // IP du conteneur Traefik
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    },
  },
}
```

## Liste de contrôle de sécurité

Avant d'activer l'authentification trusted-proxy, vérifiez :

- [ ] **Le proxy est le seul chemin** : Le port de la passerelle est protégé par pare-feu de tout sauf votre proxy
- [ ] **trustedProxies est minimal** : Seulement vos IP de proxy réelles, pas des sous-réseaux entiers
- [ ] **Le proxy supprime les en-têtes** : Votre proxy écrase (n'ajoute pas) les en-têtes `x-forwarded-*` des clients
- [ ] **Terminaison TLS** : Votre proxy gère TLS ; les utilisateurs se connectent via HTTPS
- [ ] **allowUsers est défini** (recommandé) : Restreindre aux utilisateurs connus plutôt qu'autoriser quiconque authentifié

## Audit de sécurité

`openclaw security audit` signalera l'authentification trusted-proxy avec une sévérité **critique**. C'est intentionnel — c'est un rappel que vous déléguez la sécurité à votre configuration proxy.

L'audit vérifie :

- Configuration `trustedProxies` manquante
- Configuration `userHeader` manquante
- `allowUsers` vide (autorise tout utilisateur authentifié)

## Dépannage

### "trusted_proxy_untrusted_source"

La requête ne provient pas d'une IP dans `gateway.trustedProxies`. Vérifiez :

- L'IP du proxy est-elle correcte ? (Les IP de conteneur Docker peuvent changer)
- Y a-t-il un équilibreur de charge devant votre proxy ?
- Utilisez `docker inspect` ou `kubectl get pods -o wide` pour trouver les IP réelles

### "trusted_proxy_user_missing"

L'en-tête utilisateur était vide ou manquant. Vérifiez :

- Votre proxy est-il configuré pour transmettre les en-têtes d'identité ?
- Le nom de l'en-tête est-il correct ? (insensible à la casse, mais l'orthographe compte)
- L'utilisateur est-il réellement authentifié au niveau du proxy ?

### "trusted*proxy_missing_header*\*"

Un en-tête requis n'était pas présent. Vérifiez :

- Votre configuration proxy pour ces en-têtes spécifiques
- Si les en-têtes sont supprimés quelque part dans la chaîne

### "trusted_proxy_user_not_allowed"

L'utilisateur est authentifié mais pas dans `allowUsers`. Soit ajoutez-le, soit supprimez la liste blanche.

### WebSocket échoue toujours

Assurez-vous que votre proxy :

- Supporte les mises à niveau WebSocket (`Upgrade: websocket`, `Connection: upgrade`)
- Transmet les en-têtes d'identité sur les requêtes de mise à niveau WebSocket (pas seulement HTTP)
- N'a pas de chemin d'authentification séparé pour les connexions WebSocket

## Migration depuis l'authentification par jeton

Si vous passez de l'authentification par jeton à trusted-proxy :

1. Configurez votre proxy pour authentifier les utilisateurs et transmettre les en-têtes
2. Testez la configuration proxy indépendamment (curl avec en-têtes)
3. Mettez à jour la configuration OpenClaw avec l'authentification trusted-proxy
4. Redémarrez la passerelle
5. Testez les connexions WebSocket depuis l'UI de contrôle
6. Exécutez `openclaw security audit` et passez en revue les résultats

## Connexe

- [Sécurité](/fr-FR/gateway/security) — guide de sécurité complet
- [Configuration](/fr-FR/gateway/configuration) — référence de configuration
- [Accès distant](/fr-FR/gateway/remote) — autres modèles d'accès distant
- [Tailscale](/fr-FR/gateway/tailscale) — alternative plus simple pour l'accès tailnet uniquement
