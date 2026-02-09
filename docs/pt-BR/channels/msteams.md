---
summary: "Status de suporte, capacidades e configuração do bot do Microsoft Teams"
read_when:
  - Trabalhando em recursos do canal do MS Teams
title: "Microsoft Teams"
---

# Microsoft Teams (plugin)

> "Abandonai toda esperança, vós que entrais aqui."

Atualizado: 2026-01-21

Status: texto + anexos em DMs são suportados; envio de arquivos em canais/grupos requer `sharePointSiteId` + permissões do Graph (veja [Envio de arquivos em chats em grupo](#envio-de-arquivos-em-chats-em-grupo)). Enquetes são enviadas via Adaptive Cards.

## Plugin necessário

O Microsoft Teams é distribuído como um plugin e não vem incluído na instalação principal.

**Mudança incompatível (2026.1.15):** o MS Teams saiu do core. Se você usa, é necessário instalar o plugin.

Justificativa: mantém as instalações do core mais leves e permite que as dependências do MS Teams sejam atualizadas de forma independente.

Instalação via CLI (registro npm):

```bash
openclaw plugins install @openclaw/msteams
```

Checkout local (ao executar a partir de um repositório git):

```bash
openclaw plugins install ./extensions/msteams
```

Se você escolher Teams durante a configuração/onboarding e um checkout git for detectado,
o OpenClaw oferecerá automaticamente o caminho de instalação local.

Detalhes: [Plugins](/tools/plugin)

## Configuração rápida (iniciante)

1. Instale o plugin do Microsoft Teams.
2. Crie um **Azure Bot** (App ID + client secret + tenant ID).
3. Configure o OpenClaw com essas credenciais.
4. Exponha `/api/messages` (porta 3978 por padrão) via uma URL pública ou túnel.
5. Instale o pacote do app do Teams e inicie o gateway.

Configuração mínima:

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

Nota: chats em grupo são bloqueados por padrão (`channels.msteams.groupPolicy: "allowlist"`). Para permitir respostas em grupo, defina `channels.msteams.groupAllowFrom` (ou use `groupPolicy: "open"` para permitir qualquer membro, com exigência de menção).

## Objetivos

- Conversar com o OpenClaw via DMs do Teams, chats em grupo ou canais.
- Manter o roteamento determinístico: as respostas sempre retornam ao canal de origem.
- Padrão para comportamento seguro em canais (menções obrigatórias, salvo configuração em contrário).

## Escritas de configuração

Por padrão, o Microsoft Teams tem permissão para escrever atualizações de configuração acionadas por `/config set|unset` (requer `commands.config: true`).

Desative com:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## Controle de acesso (DMs + grupos)

**Acesso por DM**

- Padrão: `channels.msteams.dmPolicy = "pairing"`. Remetentes desconhecidos são ignorados até aprovação.
- `channels.msteams.allowFrom` aceita IDs de objeto do AAD, UPNs ou nomes de exibição. O assistente resolve nomes para IDs via Microsoft Graph quando as credenciais permitem.

**Acesso em grupo**

- Padrão: `channels.msteams.groupPolicy = "allowlist"` (bloqueado a menos que você adicione `groupAllowFrom`). Use `channels.defaults.groupPolicy` para substituir o padrão quando não definido.
- `channels.msteams.groupAllowFrom` controla quais remetentes podem acionar em chats/canais de grupo (retorna para `channels.msteams.allowFrom`).
- Defina `groupPolicy: "open"` para permitir qualquer membro (ainda com exigência de menção por padrão).
- Para permitir **nenhum canal**, defina `channels.msteams.groupPolicy: "disabled"`.

Exemplo:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
  },
}
```

**Teams + lista de permissões de canais**

- Delimite respostas de grupo/canal listando equipes e canais em `channels.msteams.teams`.
- As chaves podem ser IDs ou nomes de equipes; as chaves de canal podem ser IDs de conversa ou nomes.
- Quando `groupPolicy="allowlist"` e uma lista de permissões de equipes estiver presente, apenas as equipes/canais listados são aceitos (com exigência de menção).
- O assistente de configuração aceita entradas `Team/Channel` e as armazena para você.
- Na inicialização, o OpenClaw resolve nomes de equipes/canais e listas de permissões de usuários para IDs (quando as permissões do Graph permitem)
  e registra o mapeamento; entradas não resolvidas são mantidas como digitadas.

Exemplo:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "My Team": {
          channels: {
            General: { requireMention: true },
          },
        },
      },
    },
  },
}
```

## Como funciona

1. Instale o plugin do Microsoft Teams.
2. Crie um **Azure Bot** (App ID + secret + tenant ID).
3. Crie um **pacote de app do Teams** que referencie o bot e inclua as permissões RSC abaixo.
4. Envie/instale o app do Teams em uma equipe (ou escopo pessoal para DMs).
5. Configure `msteams` em `~/.openclaw/openclaw.json` (ou variáveis de ambiente) e inicie o gateway.
6. O gateway escuta o tráfego de webhook do Bot Framework em `/api/messages` por padrão.

## Configuração do Azure Bot (Pré-requisitos)

Antes de configurar o OpenClaw, você precisa criar um recurso Azure Bot.

### Etapa 1: Criar Azure Bot

1. Acesse [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. Preencha a aba **Basics**:

   | Campo              | Valor                                                                                                        |
   | ------------------ | ------------------------------------------------------------------------------------------------------------ |
   | **Bot handle**     | Nome do seu bot, ex.: `openclaw-msteams` (deve ser único) |
   | **Subscription**   | Selecione sua assinatura do Azure                                                                            |
   | **Resource group** | Crie um novo ou use um existente                                                                             |
   | **Pricing tier**   | **Free** para dev/testes                                                                                     |
   | **Type of App**    | **Single Tenant** (recomendado — veja a nota abaixo)                                      |
   | **Creation type**  | **Create new Microsoft App ID**                                                                              |

> **Aviso de descontinuação:** a criação de novos bots multi-tenant foi descontinuada após 2025-07-31. Use **Single Tenant** para novos bots.

3. Clique em **Review + create** → **Create** (aguarde ~1–2 minutos)

### Etapa 2: Obter credenciais

1. Vá ao recurso Azure Bot → **Configuration**
2. Copie **Microsoft App ID** → este é seu `appId`
3. Clique em **Manage Password** → vá para o App Registration
4. Em **Certificates & secrets** → **New client secret** → copie o **Value** → este é seu `appPassword`
5. Vá em **Overview** → copie **Directory (tenant) ID** → este é seu `tenantId`

### Etapa 3: Configurar o endpoint de mensagens

1. No Azure Bot → **Configuration**
2. Defina **Messaging endpoint** para a URL do seu webhook:
   - Produção: `https://your-domain.com/api/messages`
   - Dev local: use um túnel (veja [Desenvolvimento local](#desenvolvimento-local-tunneling) abaixo)

### Etapa 4: Habilitar o canal Teams

1. No Azure Bot → **Channels**
2. Clique em **Microsoft Teams** → Configure → Save
3. Aceite os Termos de Serviço

## Desenvolvimento local (Tunneling)

O Teams não consegue alcançar `localhost`. Use um túnel para desenvolvimento local:

**Opção A: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**Opção B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Teams Developer Portal (Alternativa)

Em vez de criar manualmente um ZIP de manifesto, você pode usar o [Teams Developer Portal](https://dev.teams.microsoft.com/apps):

1. Clique em **+ New app**
2. Preencha as informações básicas (nome, descrição, informações do desenvolvedor)
3. Vá em **App features** → **Bot**
4. Selecione **Enter a bot ID manually** e cole o App ID do seu Azure Bot
5. Marque os escopos: **Personal**, **Team**, **Group Chat**
6. Clique em **Distribute** → **Download app package**
7. No Teams: **Apps** → **Manage your apps** → **Upload a custom app** → selecione o ZIP

Isso geralmente é mais fácil do que editar manifestos JSON manualmente.

## Testando o bot

**Opção A: Azure Web Chat (verifique o webhook primeiro)**

1. No Azure Portal → seu recurso Azure Bot → **Test in Web Chat**
2. Envie uma mensagem — você deve ver uma resposta
3. Isso confirma que o endpoint do webhook funciona antes da configuração do Teams

**Opção B: Teams (após a instalação do app)**

1. Instale o app do Teams (sideload ou catálogo da organização)
2. Encontre o bot no Teams e envie uma DM
3. Verifique os logs do gateway para atividade de entrada

## Configuração (mínima, apenas texto)

1. **Instalar o plugin do Microsoft Teams**
   - Do npm: `openclaw plugins install @openclaw/msteams`
   - De um checkout local: `openclaw plugins install ./extensions/msteams`

2. **Registro do bot**
   - Crie um Azure Bot (veja acima) e anote:
     - App ID
     - Client secret (senha do app)
     - Tenant ID (single-tenant)

3. **Manifesto do app do Teams**
   - Inclua uma entrada `bot` com `botId = <App ID>`.
   - Escopos: `personal`, `team`, `groupChat`.
   - `supportsFiles: true` (necessário para manipulação de arquivos no escopo pessoal).
   - Adicione permissões RSC (abaixo).
   - Crie ícones: `outline.png` (32x32) e `color.png` (192x192).
   - Compacte os três arquivos juntos: `manifest.json`, `outline.png`, `color.png`.

4. **Configurar o OpenClaw**

   ```json
   {
     "msteams": {
       "enabled": true,
       "appId": "<APP_ID>",
       "appPassword": "<APP_PASSWORD>",
       "tenantId": "<TENANT_ID>",
       "webhook": { "port": 3978, "path": "/api/messages" }
     }
   }
   ```

   Você também pode usar variáveis de ambiente em vez de chaves de configuração:

   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **Endpoint do bot**
   - Defina o Messaging Endpoint do Azure Bot para:
     - `https://<host>:3978/api/messages` (ou o caminho/porta escolhidos).

6. **Executar o gateway**
   - O canal do Teams inicia automaticamente quando o plugin está instalado e existe a configuração `msteams` com credenciais.

## Contexto de histórico

- `channels.msteams.historyLimit` controla quantas mensagens recentes de canal/grupo são incluídas no prompt.
- Retorna para `messages.groupChat.historyLimit`. Defina `0` para desativar (padrão 50).
- O histórico de DMs pode ser limitado com `channels.msteams.dmHistoryLimit` (turnos por usuário). Substituições por usuário: `channels.msteams.dms["<user_id>"].historyLimit`.

## Permissões RSC atuais do Teams (Manifesto)

Estas são as **permissões resourceSpecific existentes** no manifesto do nosso app do Teams. Elas só se aplicam dentro da equipe/chat onde o app está instalado.

**Para canais (escopo de equipe):**

- `ChannelMessage.Read.Group` (Application) - receber todas as mensagens do canal sem @menção
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**Para chats em grupo:**

- `ChatMessage.Read.Chat` (Application) - receber todas as mensagens do chat em grupo sem @menção

## Exemplo de manifesto do Teams (redigido)

Exemplo mínimo e válido com os campos obrigatórios. Substitua IDs e URLs.

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "name": { "short": "OpenClaw" },
  "developer": {
    "name": "Your Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": { "short": "OpenClaw in Teams", "full": "OpenClaw in Teams" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#5B6DEF",
  "bots": [
    {
      "botId": "11111111-1111-1111-1111-111111111111",
      "scopes": ["personal", "team", "groupChat"],
      "isNotificationOnly": false,
      "supportsCalling": false,
      "supportsVideo": false,
      "supportsFiles": true
    }
  ],
  "webApplicationInfo": {
    "id": "11111111-1111-1111-1111-111111111111"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChannelMessage.Send.Group", "type": "Application" },
        { "name": "Member.Read.Group", "type": "Application" },
        { "name": "Owner.Read.Group", "type": "Application" },
        { "name": "ChannelSettings.Read.Group", "type": "Application" },
        { "name": "TeamMember.Read.Group", "type": "Application" },
        { "name": "TeamSettings.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  }
}
```

### Observações do manifesto (campos obrigatórios)

- `bots[].botId` **deve** corresponder exatamente ao App ID do Azure Bot.
- `webApplicationInfo.id` **deve** corresponder ao App ID do Azure Bot.
- `bots[].scopes` deve incluir as superfícies que você pretende usar (`personal`, `team`, `groupChat`).
- `bots[].supportsFiles: true` é obrigatório para manipulação de arquivos no escopo pessoal.
- `authorization.permissions.resourceSpecific` deve incluir leitura/envio de canal se você quiser tráfego de canal.

### Atualizando um app existente

Para atualizar um app do Teams já instalado (por exemplo, para adicionar permissões RSC):

1. Atualize seu `manifest.json` com as novas configurações
2. **Incremente o campo `version`** (ex.: `1.0.0` → `1.1.0`)
3. **Recompacte** o manifesto com os ícones (`manifest.json`, `outline.png`, `color.png`)
4. Envie o novo zip:
   - **Opção A (Teams Admin Center):** Teams Admin Center → Teams apps → Manage apps → encontre seu app → Upload new version
   - **Opção B (Sideload):** No Teams → Apps → Manage your apps → Upload a custom app
5. **Para canais de equipe:** reinstale o app em cada equipe para que as novas permissões entrem em vigor
6. **Feche completamente e reabra o Teams** (não apenas fechar a janela) para limpar o cache de metadados do app

## Capacidades: apenas RSC vs Graph

### Com **apenas Teams RSC** (app instalado, sem permissões da Graph API)

Funciona:

- Ler conteúdo de **texto** de mensagens de canal.
- Enviar conteúdo de **texto** para canais.
- Receber anexos de arquivos **pessoais (DM)**.

Não funciona:

- Conteúdo de **imagem ou arquivo** em canais/grupos (o payload inclui apenas um stub HTML).
- Download de anexos armazenados no SharePoint/OneDrive.
- Leitura de histórico de mensagens (além do evento de webhook ao vivo).

### Com **Teams RSC + permissões de Aplicação do Microsoft Graph**

Adiciona:

- Download de conteúdos hospedados (imagens coladas em mensagens).
- Download de anexos de arquivos armazenados no SharePoint/OneDrive.
- Leitura de histórico de mensagens de canal/chat via Graph.

### RSC vs Graph API

| Capacidade                  | Permissões RSC                                 | Graph API                                             |
| --------------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| **Mensagens em tempo real** | Sim (via webhook)           | Não (apenas polling)               |
| **Mensagens históricas**    | Não                                            | Sim (pode consultar histórico)     |
| **Complexidade de setup**   | Apenas manifesto do app                        | Requer consentimento admin + fluxo de token           |
| **Funciona offline**        | Não (precisa estar rodando) | Sim (consultar a qualquer momento) |

**Conclusão:** RSC é para escuta em tempo real; Graph API é para acesso histórico. Para recuperar mensagens perdidas enquanto offline, você precisa da Graph API com `ChannelMessage.Read.All` (requer consentimento de administrador).

## Mídia + histórico habilitados por Graph (necessário para canais)

Se você precisa de imagens/arquivos em **canais** ou quer buscar **histórico de mensagens**, é necessário habilitar permissões do Microsoft Graph e conceder consentimento de administrador.

1. No Entra ID (Azure AD) **App Registration**, adicione permissões de **Application** do Microsoft Graph:
   - `ChannelMessage.Read.All` (anexos de canal + histórico)
   - `Chat.Read.All` ou `ChatMessage.Read.All` (chats em grupo)
2. **Conceda consentimento de administrador** para o tenant.
3. Aumente a **versão do manifesto** do app do Teams, reenvie e **reinstale o app no Teams**.
4. **Feche completamente e reabra o Teams** para limpar o cache de metadados do app.

## Limitações conhecidas

### Timeouts de webhook

O Teams entrega mensagens via webhook HTTP. Se o processamento demorar muito (por exemplo, respostas lentas de LLM), você pode ver:

- Timeouts do gateway
- O Teams tentando reenviar a mensagem (causando duplicatas)
- Respostas perdidas

O OpenClaw lida com isso retornando rapidamente e enviando respostas de forma proativa, mas respostas muito lentas ainda podem causar problemas.

### Formatação

O markdown do Teams é mais limitado que o do Slack ou Discord:

- Formatação básica funciona: **negrito**, _itálico_, `code`, links
- Markdown complexo (tabelas, listas aninhadas) pode não renderizar corretamente
- Adaptive Cards são suportados para enquetes e envio arbitrário de cards (veja abaixo)

## Configuração

Principais configurações (veja `/gateway/configuration` para padrões compartilhados entre canais):

- `channels.msteams.enabled`: habilitar/desabilitar o canal.
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: credenciais do bot.
- `channels.msteams.webhook.port` (padrão `3978`)
- `channels.msteams.webhook.path` (padrão `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (padrão: pareamento)
- `channels.msteams.allowFrom`: lista de permissões para DMs (IDs de objeto do AAD, UPNs ou nomes de exibição). O assistente resolve nomes para IDs durante a configuração quando há acesso ao Graph.
- `channels.msteams.textChunkLimit`: tamanho do bloco de texto de saída.
- `channels.msteams.chunkMode`: `length` (padrão) ou `newline` para dividir em linhas em branco (limites de parágrafo) antes do particionamento por comprimento.
- `channels.msteams.mediaAllowHosts`: lista de permissões para hosts de anexos de entrada (padrão para domínios Microsoft/Teams).
- `channels.msteams.mediaAuthAllowHosts`: lista de permissões para anexar cabeçalhos Authorization em tentativas de mídia (padrão para hosts do Graph + Bot Framework).
- `channels.msteams.requireMention`: exigir @menção em canais/grupos (padrão true).
- `channels.msteams.replyStyle`: `thread | top-level` (veja [Estilo de resposta](#estilo-de-resposta-threads-vs-posts)).
- `channels.msteams.teams.<teamId>.replyStyle`: substituição por equipe.
- `channels.msteams.teams.<teamId>.requireMention`: substituição por equipe.
- `channels.msteams.teams.<teamId>.tools`: substituições padrão de política de ferramentas por equipe (`allow`/`deny`/`alsoAllow`) usadas quando falta uma substituição por canal.
- `channels.msteams.teams.<teamId>.toolsBySender`: substituições padrão de política de ferramentas por equipe e por remetente (`"*"` com curinga suportado).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: substituição por canal.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: substituição por canal.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: substituições de política de ferramentas por canal (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: substituições de política de ferramentas por canal e por remetente (`"*"` com curinga suportado).
- `channels.msteams.sharePointSiteId`: ID do site do SharePoint para uploads de arquivos em chats/canais de grupo (veja [Envio de arquivos em chats em grupo](#envio-de-arquivos-em-chats-em-grupo)).

## Roteamento e sessões

- As chaves de sessão seguem o formato padrão do agente (veja [/concepts/session](/concepts/session)):
  - Mensagens diretas compartilham a sessão principal (`agent:<agentId>:<mainKey>`).
  - Mensagens de canal/grupo usam o id da conversa:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## Estilo de resposta: Threads vs Posts

O Teams introduziu recentemente dois estilos de UI de canal sobre o mesmo modelo de dados subjacente:

| Estilo                                        | Descrição                                                    | `replyStyle` recomendado             |
| --------------------------------------------- | ------------------------------------------------------------ | ------------------------------------ |
| **Posts** (clássico)       | Mensagens aparecem como cards com respostas em thread abaixo | `thread` (padrão) |
| **Threads** (estilo Slack) | Mensagens fluem linearmente, mais como o Slack               | `top-level`                          |

**O problema:** a API do Teams não expõe qual estilo de UI um canal usa. Se você usar o `replyStyle` errado:

- `thread` em um canal no estilo Threads → respostas aparecem aninhadas de forma estranha
- `top-level` em um canal no estilo Posts → respostas aparecem como posts de nível superior separados, em vez de em thread

**Solução:** configure `replyStyle` por canal com base em como o canal está configurado:

```json
{
  "msteams": {
    "replyStyle": "thread",
    "teams": {
      "19:abc...@thread.tacv2": {
        "channels": {
          "19:xyz...@thread.tacv2": {
            "replyStyle": "top-level"
          }
        }
      }
    }
  }
}
```

## Anexos e imagens

**Limitações atuais:**

- **DMs:** imagens e anexos de arquivos funcionam via APIs de arquivos do bot do Teams.
- **Canais/grupos:** anexos ficam no armazenamento do M365 (SharePoint/OneDrive). O payload do webhook inclui apenas um stub HTML, não os bytes reais do arquivo. **Permissões da Graph API são necessárias** para baixar anexos de canais.

Sem permissões do Graph, mensagens de canal com imagens serão recebidas apenas como texto (o conteúdo da imagem não é acessível ao bot).
Por padrão, o OpenClaw baixa mídia apenas de hostnames Microsoft/Teams. Substitua com `channels.msteams.mediaAllowHosts` (use `["*"]` para permitir qualquer host).
Cabeçalhos de autorização são anexados apenas para hosts em `channels.msteams.mediaAuthAllowHosts` (padrão para hosts do Graph + Bot Framework). Mantenha esta lista restrita (evite sufixos multi-tenant).

## Envio de arquivos em chats em grupo

Bots podem enviar arquivos em DMs usando o fluxo FileConsentCard (integrado). No entanto, **enviar arquivos em chats/canais de grupo** requer configuração adicional:

| Contexto                                           | Como os arquivos são enviados                   | Configuração necessária                         |
| -------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| **DMs**                                            | FileConsentCard → usuário aceita → bot envia    | Funciona fora da caixa                          |
| **Chats/canais de grupo**                          | Upload no SharePoint → link de compartilhamento | Requer `sharePointSiteId` + permissões do Graph |
| **Imagens (qualquer contexto)** | Inline codificado em Base64                     | Funciona fora da caixa                          |

### Por que chats em grupo precisam do SharePoint

Bots não têm um drive pessoal do OneDrive (o endpoint da Graph API `/me/drive` não funciona para identidades de aplicação). Para enviar arquivos em chats/canais de grupo, o bot faz upload para um **site do SharePoint** e cria um link de compartilhamento.

### Configuração

1. **Adicionar permissões da Graph API** no Entra ID (Azure AD) → App Registration:
   - `Sites.ReadWrite.All` (Application) - upload de arquivos no SharePoint
   - `Chat.Read.All` (Application) - opcional, habilita links de compartilhamento por usuário

2. **Conceder consentimento de administrador** para o tenant.

3. **Obter o ID do site do SharePoint:**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **Configurar o OpenClaw:**

   ```json5
   {
     channels: {
       msteams: {
         // ... other config ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### Comportamento de compartilhamento

| Permissão                               | Comportamento de compartilhamento                                                |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `Sites.ReadWrite.All` apenas            | Link de compartilhamento para toda a organização                                 |
| `Sites.ReadWrite.All` + `Chat.Read.All` | Link de compartilhamento por usuário (apenas membros do chat) |

O compartilhamento por usuário é mais seguro, pois apenas os participantes do chat podem acessar o arquivo. Se a permissão `Chat.Read.All` estiver ausente, o bot retorna ao compartilhamento para toda a organização.

### Comportamento de fallback

| Cenário                                                  | Resultado                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Chat em grupo + arquivo + `sharePointSiteId` configurado | Upload no SharePoint, enviar link de compartilhamento                           |
| Chat em grupo + arquivo + sem `sharePointSiteId`         | Tentar upload no OneDrive (pode falhar), enviar apenas texto |
| Chat pessoal + arquivo                                   | Fluxo FileConsentCard (funciona sem SharePoint)              |
| Qualquer contexto + imagem                               | Inline codificado em Base64 (funciona sem SharePoint)        |

### Local de armazenamento dos arquivos

Os arquivos enviados são armazenados em uma pasta `/OpenClawShared/` na biblioteca de documentos padrão do site do SharePoint configurado.

## Enquetes (Adaptive Cards)

O OpenClaw envia enquetes do Teams como Adaptive Cards (não existe API nativa de enquetes do Teams).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- Os votos são registrados pelo gateway em `~/.openclaw/msteams-polls.json`.
- O gateway deve permanecer online para registrar votos.
- As enquetes ainda não publicam automaticamente resumos de resultados (inspecione o arquivo de armazenamento, se necessário).

## Adaptive Cards (arbitrários)

Envie qualquer JSON de Adaptive Card para usuários ou conversas do Teams usando a ferramenta `message` ou a CLI.

O parâmetro `card` aceita um objeto JSON de Adaptive Card. Quando `card` é fornecido, o texto da mensagem é opcional.

**Ferramenta do agente:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:<id>",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello!" }]
  }
}
```

**CLI:**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'
```

Veja a [documentação do Adaptive Cards](https://adaptivecards.io/) para o esquema e exemplos. Para detalhes de formato de destino, veja [Formatos de destino](#formatos-de-destino) abaixo.

## Formatos de destino

Os destinos do MSTeams usam prefixos para distinguir entre usuários e conversas:

| Tipo de destino                       | Formato                          | Exemplo                                                                |
| ------------------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| Usuário (por ID)   | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                            |
| Usuário (por nome) | `user:<display-name>`            | `user:John Smith` (requer Graph API)                |
| Grupo/canal                           | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                               |
| Grupo/canal (raw)  | `<conversation-id>`              | `19:abc123...@thread.tacv2` (se contiver `@thread`) |

**Exemplos de CLI:**

```bash
# Send to a user by ID
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# Send to a user by display name (triggers Graph API lookup)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# Send to a group chat or channel
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# Send an Adaptive Card to a conversation
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**Exemplos de ferramenta do agente:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:John Smith",
  "message": "Hello!"
}
```

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "conversation:19:abc...@thread.tacv2",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello" }]
  }
}
```

Nota: sem o prefixo `user:`, nomes assumem resolução de grupo/equipe. Sempre use `user:` ao direcionar pessoas por nome de exibição.

## Mensagens proativas

- Mensagens proativas só são possíveis **após** um usuário ter interagido, pois armazenamos referências de conversa nesse ponto.
- Veja `/gateway/configuration` para `dmPolicy` e restrições por lista de permissões.

## IDs de equipe e canal (armadilha comum)

O parâmetro de consulta `groupId` nas URLs do Teams **NÃO** é o ID da equipe usado para configuração. Extraia os IDs do caminho da URL:

**URL da equipe:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team ID (URL-decode this)
```

**URL do canal:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**Para configuração:**

- ID da equipe = segmento do caminho após `/team/` (decodificado da URL, ex.: `19:Bk4j...@thread.tacv2`)
- ID do canal = segmento do caminho após `/channel/` (decodificado da URL)
- **Ignore** o parâmetro de consulta `groupId`

## Canais privados

Bots têm suporte limitado em canais privados:

| Funcionalidade                                       | Canais padrão | Canais privados                         |
| ---------------------------------------------------- | ------------- | --------------------------------------- |
| Instalação do bot                                    | Sim           | Limitado                                |
| Mensagens em tempo real (webhook) | Sim           | Pode não funcionar                      |
| Permissões RSC                                       | Sim           | Pode se comportar diferente             |
| @menções                                | Sim           | Se o bot for acessível                  |
| Histórico via Graph API                              | Sim           | Sim (com permissões) |

**Alternativas se canais privados não funcionarem:**

1. Use canais padrão para interações com o bot
2. Use DMs — usuários sempre podem falar diretamente com o bot
3. Use Graph API para acesso histórico (requer `ChannelMessage.Read.All`)

## Solução de problemas

### Problemas comuns

- **Imagens não aparecem em canais:** permissões do Graph ou consentimento admin ausentes. Reinstale o app do Teams e feche/reabra completamente o Teams.
- **Sem respostas no canal:** menções são exigidas por padrão; defina `channels.msteams.requireMention=false` ou configure por equipe/canal.
- **Incompatibilidade de versão (Teams ainda mostra manifesto antigo):** remova e readicione o app e feche completamente o Teams para atualizar.
- **401 Unauthorized do webhook:** esperado ao testar manualmente sem JWT do Azure — indica que o endpoint é alcançável, mas a autenticação falhou. Use o Azure Web Chat para testar corretamente.

### Erros ao enviar o manifesto

- **"Icon file cannot be empty":** o manifesto referencia arquivos de ícone com 0 bytes. Crie ícones PNG válidos (32x32 para `outline.png`, 192x192 para `color.png`).
- **"webApplicationInfo.Id already in use":** o app ainda está instalado em outra equipe/chat. Encontre e desinstale primeiro ou aguarde 5–10 minutos para propagação.
- **"Something went wrong" no upload:** envie via [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com), abra as DevTools do navegador (F12) → aba Network e verifique o corpo da resposta para o erro real.
- **Falha no sideload:** tente "Upload an app to your org's app catalog" em vez de "Upload a custom app" — isso geralmente contorna restrições de sideload.

### Permissões RSC não funcionando

1. Verifique se `webApplicationInfo.id` corresponde exatamente ao App ID do seu bot
2. Reenvie o app e reinstale na equipe/chat
3. Verifique se o administrador da organização bloqueou permissões RSC
4. Confirme que você está usando o escopo correto: `ChannelMessage.Read.Group` para equipes, `ChatMessage.Read.Chat` para chats em grupo

## Referências

- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - guia de configuração do Azure Bot
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) - criar/gerenciar apps do Teams
- [Esquema do manifesto do app do Teams](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Receber mensagens de canal com RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [Referência de permissões RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Manipulação de arquivos por bots do Teams](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (canal/grupo requer Graph)
- [Mensagens proativas](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
