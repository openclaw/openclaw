---
summary: "Secure OpenClaw with Caddy: mTLS, OAuth, and signed origin tokens"
read_when:
  - Setting up Caddy as a reverse proxy in front of OpenClaw
  - Configuring mTLS for client certificate authentication
  - Setting up OAuth with Caddy for identity-aware access
  - Enabling signed origin tokens for defense-in-depth
---

# Caddy Reverse Proxy for OpenClaw

This guide covers using Caddy as a secure reverse proxy in front of OpenClaw, providing mTLS, OAuth authentication, and signed origin tokens for defense-in-depth security.

## Why Caddy?

| Feature | Benefit |
|---------|---------|
| **Automatic HTTPS** | TLS certificates managed automatically |
| **mTLS Support** | Client certificate authentication |
| **OAuth2 Proxy** | Built-in authentication flow |
| **WebSocket Support** | Full support for OpenClaw's WS connections |
| **Zero-config** | Works out of the box |

## Architecture

```
Internet → Caddy (mTLS + OAuth) → OpenClaw Gateway
```

Caddy handles:
- TLS termination (including mTLS)
- OAuth2 authentication
- User identity headers

OpenClaw handles:
- Origin validation
- Signed token verification
- Device capability authorization

## Basic Setup

### 1. OpenClaw Configuration

```yaml
gateway:
  bind: "127.0.0.1"
  port: 18789
  auth:
    mode: "trusted-proxy"
    trustedProxy:
      userHeader: "x-forwarded-user"
      # Optional: require signed tokens
      # signedTokenHeader: "x-proxy-signed-token"
      # sharedSecret: "${OPENCLAW_PROXY_SECRET}"
      # signedTokenRequired: false
  trustedProxies:
    - "127.0.0.1"
    - "::1"
```

### 2. Caddyfile (Basic)

```Caddyfile
openclaw.yourdomain.com {
    reverse_proxy localhost:18789 {
        header_up X-Forwarded-User "{http.request.header.X-Forwarded-User}"
        header_up X-Forwarded-Proto "{scheme}"
    }
}
```

## mTLS Setup (Client Certificates)

For mutual TLS where clients present certificates:

```Caddyfile
openclaw.yourdomain.com {
    # Require client certificates
    tls {
        client_auth {
            mode require_and_verify
            trusted_ca_cert_file /path/to/ca.crt
        }
    }
    
    reverse_proxy localhost:18789 {
        header_up X-Client-CN "{tls_client.subject_common_name}"
        header_up X-Client-Verified "{tls_client.verified}"
    }
}
```

### Generate CA and Client Certs

```bash
# Create CA
openssl genrsa -out ca.key 4096
openssl req -new -x509 -days 365 -key ca.key -out ca.crt

# Create client key and CSR
openssl genrsa -out client.key 2048
openssl req -new -key client.key -out client.csr

# Sign client certificate
openssl x509 -req -days 365 -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt

# Bundle for client
cat client.crt client.key > client_bundle.pem
```

## OAuth2 Setup

### 1. Caddy with OAuth2

```Caddyfile
openclaw.yourdomain.com {
    oauth {
        client_id your_client_id
        client_secret your_client_secret
        provider google
        redirect_url https://openclaw.yourdomain.com/oauth2/callback
        scopes openid email profile
    }
    
    reverse_proxy localhost:18789 {
        header_up X-Forwarded-User "{oauth2.user.name}"
        header_up X-Forwarded-Email "{oauth2.user.email}"
    }
}
```

### 2. Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create OAuth 2.0 credentials
3. Set redirect URI to `https://yourdomain.com/oauth2/callback`
4. Add authorized JavaScript origins and redirect URIs

### 3. Restrict to Specific Users

```yaml
gateway:
  auth:
    mode: "trusted-proxy"
    trustedProxy:
      userHeader: "x-forwarded-user"
      allowUsers:
        - "user@example.com"
        - "admin@company.org"
```

## Signed Origin Tokens (Defense-in-Depth)

For additional security, enable signed origin tokens to verify requests came through your proxy:

### 1. OpenClaw Configuration

```yaml
gateway:
  auth:
    mode: "trusted-proxy"
    trustedProxy:
      userHeader: "x-forwarded-user"
      signedTokenHeader: "x-proxy-signed-token"
      sharedSecret: "${OPENCLAW_PROXY_SECRET}"
      signedTokenRequired: false  # Set true to enforce
```

### 2. Caddy Configuration

Generate HMAC signature for the token:

```Caddyfile
openclaw.yourdomain.com {
    # Add signed token with HMAC-SHA256
    reverse_proxy localhost:18789 {
        header_up X-Proxy-Signed-Token "{hmac_sha256:your-secret-key:{http.request.header.Origin}}"
    }
}
```

### Token Format

The token is: `base64url(payload).base64url(signature)`

**Payload:**
```json
{
  "sub": "user@example.com",
  "origin": "https://openclaw.yourdomain.com",
  "iat": 1234567890,
  "exp": 1234568190,
  "nonce": "random-string"
}
```

**Signature:**
```
HMAC-SHA256(sharedSecret, base64url(payload))
```

### Generate Token (External Script)

For complex token generation, use a script:

```python
import hmac
import hashlib
import base64
import json
import time

def create_signed_token(secret, user, origin):
    payload = {
        "sub": user,
        "origin": origin,
        "iat": int(time.time()),
        "exp": int(time.time()) + 300,
        "nonce": os.urandom(16).hex()
    }
    
    payload_b64 = base64.urlsafe_b64encode(
        json.dumps(payload).encode()
    ).decode().rstrip('=')
    
    signature = hmac.new(
        secret.encode(),
        payload_b64.encode(),
        hashlib.sha256
    ).digest()
    
    sig_b64 = base64.urlsafe_b64encode(signature).decode().rstrip('=')
    
    return f"{payload_b64}.{sig_b64}"
```

## Complete Secure Configuration

```Caddyfile
openclaw.yourdomain.com {
    # TLS with mTLS
    tls {
        client_auth {
            mode require_and_verify
            trusted_ca_cert_file /etc/caddy/ca.crt
        }
    }
    
    # OAuth authentication
    oauth {
        client_id your_client_id
        client_secret your_client_secret
        provider keycloak https://keycloak.yourdomain.com/realms/company
        scopes openid email profile
    }
    
    # Reverse proxy with headers
    reverse_proxy localhost:18789 {
        header_up X-Forwarded-User "{oauth2.user.name}"
        header_up X-Forwarded-Email "{oauth2.user.email}"
        header_up X-Forwarded-Proto "{scheme}"
        
        # Signed token for defense-in-depth
        header_up X-Proxy-Signed-Token "{hmac_sha256:your-secret:{http.request.header.Origin}}"
    }
}
```

## Security Comparison

| Setup | Security Level | Use Case |
|-------|---------------|----------|
| Basic HTTP + Auth Mode | Standard | Development |
| TLS + trusted-proxy | Good | Production (team) |
| TLS + OAuth + trusted-proxy | Better | Production (company) |
| mTLS + OAuth + signed tokens | **Best** | High-security Enterprise |

## Troubleshooting

### WebSocket Connection Issues

Ensure Caddy passes WebSocket headers:

```Caddyfile
reverse_proxy localhost:18789 {
    header_up Upgrade "{header.Connection}"
    header_up Connection "{header.Upgrade}"
    header_up Sec-WebSocket-Version "{header.Sec-WebSocket-Version}"
    header_up Sec-WebSocket-Key "{header.Sec-WebSocket-Key}"
}
```

### Token Verification Fails

1. Verify secret matches between Caddy and OpenClaw
2. Check origin header is being passed correctly
3. Ensure token hasn't expired (max 5 minutes)

### mTLS Not Working

1. Verify CA certificate is correct
2. Check client certificate is not expired
3. Ensure `mode` is set to `require_and_verify`

## See Also

- [Trusted Proxy Auth](/gateway/trusted-proxy-auth)
- [Configuration Reference](/gateway/configuration-reference)
- [Tailscale Setup](/gateway/tailscale)
