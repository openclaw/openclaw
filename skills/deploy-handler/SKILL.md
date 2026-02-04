---
name: deploy-handler
description: "Configure custom domains for client sites. Generates DNS instructions, verifies propagation, and delivers final site to client."
homepage: https://docs.lovable.dev/features/custom-domain
metadata:
  {
    "openclaw":
      {
        "emoji": "🚀",
        "requires": { "env": ["LOVABLE_API_KEY"], "config": ["browser.enabled"] },
        "tags": ["deployment", "dns", "custom-domain"],
      },
  }
---

# Deploy Handler Skill

Configure custom domains for client sites and deliver final projects.

## CRITICAL RULE

**NEVER mention the platform name (Lovable) to the client.**
- Always refer to it as "seu site", "a plataforma", or "nosso sistema"
- Dashboard links should be sent without context about the platform
- Remove any platform branding from client-facing messages

## Overview

This skill handles the final delivery phase of website creation:
1. Collecting custom domain information from the client
2. Generating DNS configuration instructions
3. Configuring the domain in the platform
4. Monitoring DNS propagation
5. Delivering the final site to the client

## How Custom Domains Work

- **Custom domains supported** with A + TXT records
- **Automatic setup** via Entri (for supported registrars)
- **Manual setup** for other registrars
- **Propagation:** typically 1-4 hours, up to 72 hours
- **SSL/TLS:** Certificates managed automatically

### DNS Records Required

| Record Type | Name | Value |
|-------------|------|-------|
| A | @ (or empty) | 76.76.21.21 |
| TXT | @ | site-verification={PROJECT_ID} |

## Workflow

```
┌─────────────────────────────────────────────────────────────┐
│                    DEPLOY HANDLER                           │
└─────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ 1. COLLECT   │   │ 2. CONFIG    │   │ 3. VERIFY    │
│              │   │              │   │              │
│ - Domain     │   │ - Platform   │   │ - DNS lookup │
│ - Registrar  │   │   settings   │   │ - SSL check  │
│ - Has access?│   │ - Get records│   │ - Notify     │
└──────────────┘   └──────────────┘   └──────────────┘
        │                   │                   │
        └───────────────────┴───────────────────┘
                            │
                            ▼
                   ┌──────────────┐
                   │ 4. DELIVER   │
                   │              │
                   │ - Final URL  │
                   │ - Credentials│
                   │ - Support    │
                   └──────────────┘
```

## Step 1: Collect Domain Information

### Initial Message Template

```
Agora vamos configurar seu domínio personalizado! 🌐

Você já tem um domínio registrado?
(ex: seusite.com.br, suaempresa.com)

Se não tiver, posso te indicar onde registrar.
```

### Follow-up Questions

If client has a domain:
```
Ótimo! Qual é o seu domínio?
E em qual empresa ele está registrado? (ex: Registro.br, GoDaddy, Cloudflare, Hostgator)
```

If client needs to register:
```
Para registrar um domínio .com.br, recomendo:
- Registro.br (https://registro.br) - oficial brasileiro
- Custo: ~R$ 40/ano

Para domínios .com, .net, etc:
- Cloudflare (https://cloudflare.com) - preços competitivos
- GoDaddy (https://godaddy.com) - popular, fácil de usar

Quer que eu te ajude após registrar?
```

## Step 2: Configure Domain in Platform

### Browser Automation Steps (Internal - not shown to client)

1. Navigate to project settings:
   ```
   https://lovable.dev/projects/{PROJECT_ID}/settings/domains
   ```

2. Click "Add custom domain"

3. Enter the client's domain

4. Capture the verification records displayed

### Retrieving DNS Records

After adding the domain, capture:
- A record IP address (76.76.21.21)
- TXT verification code

## Step 3: Generate DNS Instructions

### Template: Registro.br

```
Para conectar seu domínio, siga estes passos:

📋 **Configuração DNS - Registro.br**

1. Acesse https://registro.br e faça login
2. Clique no seu domínio → "DNS"
3. Se estiver usando DNS do Registro.br, clique em "Editar zona"
4. Adicione estes registros:

**Registro A:**
- Tipo: A
- Nome: @ (ou deixe vazio)
- Valor: 76.76.21.21

**Registro TXT:**
- Tipo: TXT
- Nome: @
- Valor: {VERIFICATION_CODE}

5. Salve as alterações

⏱️ A propagação pode levar até 24h, mas geralmente é mais rápido.
Te aviso assim que estiver funcionando!
```

### Template: Cloudflare

```
Para conectar seu domínio, siga estes passos:

📋 **Configuração DNS - Cloudflare**

1. Acesse https://dash.cloudflare.com e faça login
2. Selecione seu domínio
3. Vá em "DNS" → "Records"
4. Adicione os registros abaixo:

**Registro A:**
- Tipo: A
- Nome: @
- Conteúdo: 76.76.21.21
- Proxy: OFF (nuvem cinza)

**Registro TXT:**
- Tipo: TXT
- Nome: @
- Conteúdo: {VERIFICATION_CODE}

5. Salve cada registro

⚠️ IMPORTANTE: Desative o proxy (nuvem laranja → cinza) para o registro A.

⏱️ Cloudflare propaga rapidamente, geralmente em minutos!
```

### Template: GoDaddy

```
Para conectar seu domínio, siga estes passos:

📋 **Configuração DNS - GoDaddy**

1. Acesse https://dcc.godaddy.com e faça login
2. Clique no seu domínio → "DNS"
3. Em "Records", adicione:

**Registro A:**
- Clique "Add New Record"
- Tipo: A
- Nome: @
- Valor: 76.76.21.21
- TTL: 600 (ou 1 hora)

**Registro TXT:**
- Clique "Add New Record"
- Tipo: TXT
- Nome: @
- Valor: {VERIFICATION_CODE}
- TTL: 600

4. Clique "Save" em cada registro

⏱️ A propagação pode levar 24-48h no GoDaddy.
```

### Template: Hostgator/cPanel

```
Para conectar seu domínio, siga estes passos:

📋 **Configuração DNS - Hostgator/cPanel**

1. Acesse seu cPanel (geralmente seusite.com.br/cpanel)
2. Procure "Zone Editor" ou "Editor de Zona DNS"
3. Selecione seu domínio

**Registro A:**
- Clique "Add Record" → "A Record"
- Nome: seu domínio (ex: meucafe.com.br)
- Endereço: 76.76.21.21

**Registro TXT:**
- Clique "Add Record" → "TXT Record"
- Nome: seu domínio
- Valor: {VERIFICATION_CODE}

4. Salve as alterações

⏱️ A propagação pode levar até 24h.
```

### Template: Generic

```
Para conectar seu domínio, você precisa adicionar estes registros DNS:

📋 **Registros necessários**

**Registro A:**
- Tipo: A
- Host/Nome: @ (ou seu domínio)
- Aponta para: 76.76.21.21

**Registro TXT:**
- Tipo: TXT
- Host/Nome: @ (ou seu domínio)
- Valor: {VERIFICATION_CODE}

Se precisar de ajuda para encontrar onde configurar no seu provedor, me avise!

⏱️ A propagação geralmente leva 1-4 horas, mas pode levar até 72h.
```

## Step 4: Verify DNS Propagation

### Verification Commands (Internal)

```bash
# Check A record
dig +short {DOMAIN} A

# Check TXT record
dig +short {DOMAIN} TXT

# Check SSL certificate
curl -I https://{DOMAIN}
```

### Propagation Status

Track propagation in state:
- `pending` - DNS not configured yet
- `propagating` - DNS configured, waiting for propagation
- `live` - Site is accessible with SSL

### Checking Propagation Programmatically

```javascript
async function checkDnsPropagation(domain) {
  const expectedA = '76.76.21.21';

  try {
    // Check A record
    const aRecord = await dnsLookup(domain, 'A');
    const aOk = aRecord.includes(expectedA);

    // Check if site is accessible
    const response = await fetch(`https://${domain}`, { method: 'HEAD' });
    const siteOk = response.ok;

    return {
      aRecord: aOk,
      siteAccessible: siteOk,
      status: aOk && siteOk ? 'live' : 'propagating'
    };
  } catch (error) {
    return { status: 'pending', error: error.message };
  }
}
```

### Propagation Check Message

```
Estou verificando a propagação do seu domínio...

🔍 Registro A: {A_STATUS}
🔍 Registro TXT: {TXT_STATUS}
🔍 Site acessível: {SITE_STATUS}

{STATUS_MESSAGE}
```

Status messages:
- Pending: "Os registros DNS ainda não foram detectados. Você já configurou?"
- Propagating: "Os registros estão propagando. Isso pode levar algumas horas."
- Live: "Tudo pronto! Seu site está funcionando!"

## Step 5: Final Delivery

### Propagation Complete Message

```
✅ Seu domínio está configurado e funcionando!

🌐 **Seu site:** https://{CUSTOM_DOMAIN}

O certificado SSL já está ativo (cadeado verde).
```

### Final Delivery Message

**IMPORTANT: Do NOT include platform dashboard link in client messages unless explicitly requested.**

```
🎉 **Entrega Concluída!**

Aqui estão os dados do seu site:

🌐 **URL:** https://{CUSTOM_DOMAIN}

📧 **Suporte:** 30 dias incluídos
📱 **Contato:** Qualquer dúvida, é só chamar!

Obrigado pela confiança! 🙏
```

If client asks for admin access (store this internally, do not proactively share):
- Dashboard: `https://lovable.dev/projects/{PROJECT_ID}`

## State Tracking

Add to website-builder state:

```json
{
  "deployment": {
    "status": "pending|collecting_domain|configuring|propagating|live",
    "customDomain": "",
    "registrar": "",
    "dnsRecords": {
      "aRecord": "76.76.21.21",
      "txtRecord": ""
    },
    "propagationStarted": null,
    "liveAt": null,
    "verificationAttempts": 0
  }
}
```

### Status Transitions

1. `pending` → Payment confirmed, ready to collect domain
2. `collecting_domain` → Asking client for domain info
3. `configuring` → Adding domain in platform, sending DNS instructions
4. `propagating` → Waiting for DNS to propagate
5. `live` → Site accessible, delivery complete

## Integration

### With website-builder Skill

This skill is triggered by website-builder Phase 7 after payment confirmation:

```
Payment webhook received →
  Update status to "payment_confirmed" →
    Trigger deploy-handler skill
```

### With lovable-creator Skill (Internal)

Uses `lovableProjectId` from website-builder state to:
- Access project settings
- Add custom domain
- Get verification records

### With stripe-payments Skill

Listens for `checkout.session.completed` webhook to:
- Mark payment as confirmed
- Trigger deployment workflow

## Automatic Domain Configuration (Entri)

Some registrars support automatic configuration via Entri:

**Supported registrars:**
- GoDaddy
- Namecheap
- Google Domains
- Cloudflare
- And others

When available, offer automatic setup:

```
Detectei que seu domínio está no {REGISTRAR}.

Posso configurar automaticamente os registros DNS para você!
Você será redirecionado para autorizar a configuração.

Quer que eu configure automaticamente? (responda sim ou não)
```

## Troubleshooting

### Common Issues

**DNS not propagating:**
- Verify records were saved correctly
- Check if old records are conflicting
- Wait longer (up to 72h)
- Try clearing DNS cache

**SSL certificate errors:**
- Usually resolves within 15 minutes of DNS propagation
- Certificates are auto-generated

**Site shows wrong content:**
- Old DNS cache - wait or clear cache
- Conflicting A records - remove duplicates

### Troubleshooting Message

```
Parece que há um problema com a configuração. Vamos verificar:

1. Os registros DNS foram salvos corretamente?
2. Existe algum registro A antigo que precisa ser removido?
3. O proxy do Cloudflare está desativado (se aplicável)?

Se precisar, posso verificar a configuração atual.
```

## White-Label Guidelines

**NEVER reveal to the client:**
- Platform name (Lovable)
- Platform URLs (lovable.dev, *.lovable.app)
- Internal tooling or processes

**Always use:**
- "seu site", "a plataforma", "nosso sistema"
- Custom domain URL only (never the *.lovable.app preview URL)
- Generic terms for technical processes
