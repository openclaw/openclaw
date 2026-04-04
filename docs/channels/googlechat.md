With this config, any request to `your-domain.com/` will be ignored or returned as 404, while `your-domain.com/googlechat` is safely routed to OpenClaw.

### Option C: Cloudflare Tunnel

Configure your tunnel's ingress rules to only route the webhook path:

- **Path match**: `/googlechat`
- **Target origin**: `http://localhost:18789/googlechat`
- **Default Rule**: HTTP 404 (Not Found)

## How it works
