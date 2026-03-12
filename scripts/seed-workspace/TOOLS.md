# TOOLS.md - Local Notes

### gog (Google Workspace)

- GOG_KEYRING_PASSWORD=lawbstah2026
- Always pass env: `GOG_KEYRING_PASSWORD="lawbstah2026"`
- **Default account: john.schneider@chameleon.co** (use for calendar & email unless specified otherwise)
- Accounts:
  - john.schneider@chameleon.co (DEFAULT)
  - john.h.schneider@gmail.com
  - jschneider@radicaldesign.co
- Services: gmail, calendar, drive, contacts, docs, sheets

### Microsoft 365 (Graph API)

- Account: john@jhsconsulting.net
- Client ID: $M365_CLIENT_ID (Fly secret)
- Tenant ID: $M365_TENANT_ID (Fly secret)
- Client Secret: $M365_CLIENT_SECRET (Fly secret)
- Token file: /data/m365-tokens.json
- Scopes: Mail, Calendar, SharePoint, Teams, Files
- Shared mailbox: john@rockypointlakeglenville.com
- To refresh tokens:
  ```
  REFRESH_TOKEN=$(python3 -c "import json; print(json.load(open('/data/m365-tokens.json'))['refresh_token'])")
  curl -s -X POST "https://login.microsoftonline.com/$M365_TENANT_ID/oauth2/v2.0/token" \
    --data-urlencode "client_id=$M365_CLIENT_ID" \
    --data-urlencode "grant_type=refresh_token" \
    --data-urlencode "refresh_token=$REFRESH_TOKEN"
  ```

### QuickBooks Online

- Client ID: $QBO_CLIENT_ID (Fly secret)
- Client Secret: $QBO_CLIENT_SECRET (Fly secret)
- JHS Digital Consulting: /data/quickbooks-tokens.json (realm 9130357712650476)
- Rocky Point Rentals: /data/quickbooks-tokens-2.json (realm 9130358009387976)
- To refresh tokens:
  ```
  REFRESH_TOKEN=$(python3 -c "import json; print(json.load(open('/data/quickbooks-tokens.json'))['refresh_token'])")
  curl -s -X POST "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer" \
    -H "Accept: application/json" \
    --data-urlencode "grant_type=refresh_token" \
    --data-urlencode "refresh_token=$REFRESH_TOKEN" \
    --data-urlencode "client_id=$QBO_CLIENT_ID" \
    --data-urlencode "client_secret=$QBO_CLIENT_SECRET"
  ```

### HubSpot

- MCP server: `hubspot` (via mcporter, `@hubspot/mcp-server`)
- Token: $HUBSPOT_TOKEN (Fly secret)
- Portal ID: 45661608
- Hub domain: app.hubspot.com
- Scopes: contacts read/write, lists read/write
- Timezone: US/Eastern

### 1Password

- Service Account Token: $OP_SERVICE_ACCOUNT_TOKEN (Fly secret)
- Config dir: `/home/node/.config/op` (chmod 700)
- Vaults: Chameleon Collective, Family Finance
- Usage: `OP_CONFIG_DIR=/home/node/.config/op op <command>`

### Vercel

- Account 1 (CLI + API): JHS Digital Consulting + Orlando Health teams
  - Token: $VERCEL_TOKEN_JHSDC (Fly secret)
  - User: jhsdc (john.schneider@jhsconsulting.net)
- Account 2 (API token): Aventiv/Securus
  - Token: $VERCEL_TOKEN_AVENTIV (Fly secret)

### Atlassian

- **JHSDC** (Larry's Next Steps): https://jhsdc.atlassian.net
  - Login: john.schneider@jhsconsulting.net
  - API Token: $ATLASSIAN_TOKEN_JHSDC (Fly secret)
  - Project: LLP (Larrys Lobster Pot) - for tracking next steps
- Aventiv: https://aventiv.atlassian.net
  - Login: a0017343@securustechnologies.com
  - API Token: $ATLASSIAN_TOKEN_AVENTIV (Fly secret)
- Orlando Health: https://orlandohealth.atlassian.net
  - Login: john.schneider@orlandohealth.com
  - API Token: $ATLASSIAN_TOKEN_OH (Fly secret)

### Harvest

- Account: JHS Digital Consulting LLC
- Account ID: $HARVEST_ACCOUNT_ID (Fly secret)
- User ID: 4757403
- Token: $HARVEST_ACCESS_TOKEN (Fly secret)
- API: https://api.harvestapp.com/api/v2
- Usage:
  ```
  curl -H "Authorization: Bearer $HARVEST_ACCESS_TOKEN" -H "Harvest-Account-Id: $HARVEST_ACCOUNT_ID" ...
  ```

### OwnerRez

- Token: $OWNERREZ_API_TOKEN (Fly secret)
- Usage: `curl -H "Authorization: Bearer $OWNERREZ_API_TOKEN" ...`

### GitHub

- Username: jhs129
- Auth: gh CLI (logged in)

### Telegram

- Bot: @lawbstah_bot
- John: @schnite (id: 8416817283)
