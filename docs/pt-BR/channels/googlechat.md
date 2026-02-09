---
summary: "Status de suporte do app Google Chat, capacidades e configuração"
read_when:
  - Trabalhando em recursos do canal Google Chat
title: "Google Chat"
---

# Google Chat (Chat API)

Status: pronto para DMs + espaços via webhooks da Google Chat API (somente HTTP).

## Início rápido (iniciante)

1. Crie um projeto no Google Cloud e ative a **Google Chat API**.
   - Acesse: [Credenciais da Google Chat API](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - Ative a API se ela ainda não estiver ativada.
2. Crie uma **Conta de serviço**:
   - Clique em **Criar credenciais** > **Conta de serviço**.
   - Dê o nome que quiser (por exemplo, `openclaw-chat`).
   - Deixe as permissões em branco (clique em **Continuar**).
   - Deixe os principais com acesso em branco (clique em **Concluir**).
3. Crie e faça o download da **Chave JSON**:
   - Na lista de contas de serviço, clique na que você acabou de criar.
   - Vá para a aba **Chaves**.
   - Clique em **Adicionar chave** > **Criar nova chave**.
   - Selecione **JSON** e clique em **Criar**.
4. Armazene o arquivo JSON baixado no host do seu gateway (por exemplo, `~/.openclaw/googlechat-service-account.json`).
5. Crie um app do Google Chat no [Console do Google Cloud – Configuração do Chat](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat):
   - Preencha as **Informações do aplicativo**:
     - **Nome do app**: (por exemplo, `OpenClaw`)
     - **URL do avatar**: (por exemplo, `https://openclaw.ai/logo.png`)
     - **Descrição**: (por exemplo, `Personal AI Assistant`)
   - Ative **Recursos interativos**.
   - Em **Funcionalidade**, marque **Entrar em espaços e conversas em grupo**.
   - Em **Configurações de conexão**, selecione **URL de endpoint HTTP**.
   - Em **Gatilhos**, selecione **Usar um endpoint HTTP comum para todos os gatilhos** e defina como a URL pública do seu gateway seguida de `/googlechat`.
     - _Dica: Execute `openclaw status` para encontrar a URL pública do seu gateway._
   - Em **Visibilidade**, marque **Disponibilizar este app do Chat para pessoas e grupos específicos em &lt;Seu Domínio&gt;**.
   - Digite seu endereço de e-mail (por exemplo, `user@example.com`) na caixa de texto.
   - Clique em **Salvar** na parte inferior.
6. **Ative o status do app**:
   - Após salvar, **atualize a página**.
   - Procure a seção **Status do app** (geralmente perto do topo ou da parte inferior após salvar).
   - Altere o status para **Ao vivo – disponível para usuários**.
   - Clique em **Salvar** novamente.
7. Configure o OpenClaw com o caminho da conta de serviço + audiência do webhook:
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - Ou configuração: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. Defina o tipo + valor da audiência do webhook (corresponde à configuração do seu app do Chat).
9. Inicie o gateway. O Google Chat fará POST para o caminho do seu webhook.

## Adicionar ao Google Chat

Quando o gateway estiver em execução e seu e-mail estiver adicionado à lista de visibilidade:

1. Acesse [Google Chat](https://chat.google.com/).
2. Clique no ícone **+** (mais) ao lado de **Mensagens diretas**.
3. Na barra de pesquisa (onde você normalmente adiciona pessoas), digite o **Nome do app** que você configurou no Console do Google Cloud.
   - **Nota**: O bot _não_ aparecerá na lista de navegação do “Marketplace” porque é um app privado. Você deve procurá-lo pelo nome.
4. Selecione seu bot nos resultados.
5. Clique em **Adicionar** ou **Conversar** para iniciar uma conversa 1:1.
6. Envie "Hello" para acionar o assistente!

## URL pública (somente webhook)

Os webhooks do Google Chat exigem um endpoint HTTPS público. Por segurança, **exponha apenas o caminho `/googlechat`** para a internet. Mantenha o dashboard do OpenClaw e outros endpoints sensíveis na sua rede privada.

### Opção A: Tailscale Funnel (Recomendado)

Use o Tailscale Serve para o dashboard privado e o Funnel para o caminho público do webhook. Isso mantém `/` privado enquanto expõe apenas `/googlechat`.

1. **Verifique em qual endereço seu gateway está vinculado:**

   ```bash
   ss -tlnp | grep 18789
   ```

   Anote o endereço IP (por exemplo, `127.0.0.1`, `0.0.0.0` ou seu IP do Tailscale como `100.x.x.x`).

2. **Exponha o dashboard apenas para o tailnet (porta 8443):**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **Exponha publicamente apenas o caminho do webhook:**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **Autorize o nó para acesso ao Funnel:**
   Se solicitado, visite a URL de autorização mostrada na saída para habilitar o Funnel para este nó na política do seu tailnet.

5. **Verifique a configuração:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

Sua URL pública de webhook será:
`https://<node-name>.<tailnet>.ts.net/googlechat`

Seu dashboard privado permanece apenas no tailnet:
`https://<node-name>.<tailnet>.ts.net:8443/`

Use a URL pública (sem `:8443`) na configuração do app do Google Chat.

> Nota: Esta configuração persiste após reinicializações. Para removê-la mais tarde, execute `tailscale funnel reset` e `tailscale serve reset`.

### Opção B: Proxy reverso (Caddy)

Se você usar um proxy reverso como o Caddy, faça o proxy apenas do caminho específico:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

Com essa configuração, qualquer requisição para `your-domain.com/` será ignorada ou retornará como 404, enquanto `your-domain.com/googlechat` é roteado com segurança para o OpenClaw.

### Opção C: Cloudflare Tunnel

Configure as regras de ingresso do seu túnel para rotear apenas o caminho do webhook:

- **Caminho**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Regra padrão**: HTTP 404 (Não encontrado)

## Como funciona

1. O Google Chat envia POSTs de webhook para o gateway. Cada requisição inclui um cabeçalho `Authorization: Bearer <token>`.
2. O OpenClaw verifica o token em relação ao `audienceType` + `audience` configurados:
   - `audienceType: "app-url"` → a audiência é a sua URL HTTPS do webhook.
   - `audienceType: "project-number"` → a audiência é o número do projeto Cloud.
3. As mensagens são roteadas por espaço:
   - DMs usam a chave de sessão `agent:<agentId>:googlechat:dm:<spaceId>`.
   - Espaços usam a chave de sessão `agent:<agentId>:googlechat:group:<spaceId>`.
4. O acesso a DM é por pareamento por padrão. Remetentes desconhecidos recebem um código de pareamento; aprove com:
   - `openclaw pairing approve googlechat <code>`
5. Espaços em grupo exigem @menção por padrão. Use `botUser` se a detecção de menção precisar do nome de usuário do app.

## Alvos

Use estes identificadores para entrega e listas de permissões:

- Mensagens diretas: `users/<userId>` ou `users/<email>` (endereços de e-mail são aceitos).
- Espaços: `spaces/<spaceId>`.

## Destaques de configuração

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; helps mention detection
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890", "name@example.com"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": {
          allow: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Short answers only.",
        },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

Notas:

- As credenciais da conta de serviço também podem ser passadas inline com `serviceAccount` (string JSON).
- O caminho padrão do webhook é `/googlechat` se `webhookPath` não estiver definido.
- Reações estão disponíveis via a ferramenta `reactions` e `channels action` quando `actions.reactions` está habilitado.
- `typingIndicator` suporta `none`, `message` (padrão) e `reaction` (reação exige OAuth do usuário).
- Anexos são baixados pela Chat API e armazenados no pipeline de mídia (tamanho limitado por `mediaMaxMb`).

## Solução de problemas

### 405 Method Not Allowed

Se o Google Cloud Logs Explorer mostrar erros como:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

Isso significa que o manipulador de webhook não está registrado. Causas comuns:

1. **Canal não configurado**: A seção `channels.googlechat` está ausente na sua configuração. Verifique com:

   ```bash
   openclaw config get channels.googlechat
   ```

   Se retornar "Config path not found", adicione a configuração (veja [Destaques de configuração](#config-highlights)).

2. **Plugin não habilitado**: Verifique o status do plugin:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   Se mostrar "disabled", adicione `plugins.entries.googlechat.enabled: true` à sua configuração.

3. **Gateway não reiniciado**: Após adicionar a configuração, reinicie o gateway:

   ```bash
   openclaw gateway restart
   ```

Verifique se o canal está em execução:

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### Outros problemas

- Verifique `openclaw channels status --probe` para erros de autenticação ou configuração de audiência ausente.
- Se nenhuma mensagem chegar, confirme a URL do webhook + assinaturas de eventos do app do Chat.
- Se o bloqueio por menção impedir respostas, defina `botUser` para o nome do recurso de usuário do app e verifique `requireMention`.
- Use `openclaw logs --follow` enquanto envia uma mensagem de teste para ver se as requisições chegam ao gateway.

Documentos relacionados:

- [Configuração do Gateway](/gateway/configuration)
- [Segurança](/gateway/security)
- [Reações](/tools/reactions)
