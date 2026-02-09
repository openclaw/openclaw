---
summary: "Status de suporte do Matrix, capacidades e configuração"
read_when:
  - Trabalhando em recursos do canal Matrix
title: "Matrix"
---

# Matrix (plugin)

Matrix é um protocolo de mensagens aberto e descentralizado. O OpenClaw se conecta como um **usuário**
Matrix em qualquer homeserver, portanto você precisa de uma conta Matrix para o bot. Depois de fazer login, você pode enviar DM
diretamente para o bot ou convidá-lo para salas (Matrix “grupos”). O Beeper também é uma opção válida de cliente,
mas requer que o E2EE esteja habilitado.

Status: suportado via plugin (@vector-im/matrix-bot-sdk). Mensagens diretas, salas, threads, mídia, reações,
enquetes (envio + início de enquete como texto), localização e E2EE (com suporte a crypto).

## Plugin necessário

Matrix é distribuído como um plugin e não vem incluído na instalação principal.

Instale via CLI (registro npm):

```bash
openclaw plugins install @openclaw/matrix
```

Checkout local (ao executar a partir de um repositório git):

```bash
openclaw plugins install ./extensions/matrix
```

Se você escolher Matrix durante a configuração/integração inicial e um checkout git for detectado,
o OpenClaw oferecerá automaticamente o caminho de instalação local.

Detalhes: [Plugins](/tools/plugin)

## Configuração

1. Instale o plugin Matrix:
   - Do npm: `openclaw plugins install @openclaw/matrix`
   - De um checkout local: `openclaw plugins install ./extensions/matrix`

2. Crie uma conta Matrix em um homeserver:
   - Veja opções de hospedagem em [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - Ou hospede você mesmo.

3. Obtenha um token de acesso para a conta do bot:

   - Use a API de login do Matrix com `curl` no seu homeserver:

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - Substitua `matrix.example.org` pela URL do seu homeserver.
   - Ou defina `channels.matrix.userId` + `channels.matrix.password`: o OpenClaw chama o mesmo
     endpoint de login, armazena o token de acesso em `~/.openclaw/credentials/matrix/credentials.json`,
     e o reutiliza na próxima inicialização.

4. Configure as credenciais:
   - Env: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (ou `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - Ou config: `channels.matrix.*`
   - Se ambos estiverem definidos, a configuração tem precedência.
   - Com token de acesso: o ID do usuário é obtido automaticamente via `/whoami`.
   - Quando definido, `channels.matrix.userId` deve ser o ID Matrix completo (exemplo: `@bot:example.org`).

5. Reinicie o gateway (ou conclua a integração inicial).

6. Inicie uma DM com o bot ou convide-o para uma sala a partir de qualquer cliente Matrix
   (Element, Beeper, etc.; veja [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)). O Beeper requer E2EE,
   então defina `channels.matrix.encryption: true` e verifique o dispositivo.

Configuração mínima (token de acesso, ID do usuário obtido automaticamente):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

Configuração E2EE (criptografia de ponta a ponta habilitada):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## Criptografia (E2EE)

A criptografia de ponta a ponta é **suportada** via o SDK de crypto em Rust.

Habilite com `channels.matrix.encryption: true`:

- Se o módulo de crypto carregar, salas criptografadas são descriptografadas automaticamente.
- Mídia de saída é criptografada ao enviar para salas criptografadas.
- Na primeira conexão, o OpenClaw solicita verificação do dispositivo a partir de suas outras sessões.
- Verifique o dispositivo em outro cliente Matrix (Element, etc.) para habilitar o compartilhamento de chaves.
- Se o módulo de crypto não puder ser carregado, o E2EE é desativado e salas criptografadas não serão descriptografadas;
  o OpenClaw registra um aviso.
- Se você vir erros de módulo de crypto ausente (por exemplo, `@matrix-org/matrix-sdk-crypto-nodejs-*`),
  permita scripts de build para `@matrix-org/matrix-sdk-crypto-nodejs` e execute
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` ou obtenha o binário com
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`.

O estado de crypto é armazenado por conta + token de acesso em
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(banco de dados SQLite). O estado de sincronização fica ao lado em `bot-storage.json`.
Se o token de acesso (dispositivo) mudar, um novo armazenamento é criado e o bot deve ser
reverificado para salas criptografadas.

**Verificação de dispositivo:**
Quando o E2EE está habilitado, o bot solicita verificação das suas outras sessões na inicialização.
Abra o Element (ou outro cliente) e aprove a solicitação de verificação para estabelecer confiança.
Depois de verificado, o bot pode descriptografar mensagens em salas criptografadas.

## Modelo de roteamento

- As respostas sempre retornam para o Matrix.
- DMs compartilham a sessão principal do agente; salas mapeiam para sessões de grupo.

## Controle de acesso (DMs)

- Padrão: `channels.matrix.dm.policy = "pairing"`. Remetentes desconhecidos recebem um código de pareamento.
- Aprovar via:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- DMs públicas: `channels.matrix.dm.policy="open"` mais `channels.matrix.dm.allowFrom=["*"]`.
- `channels.matrix.dm.allowFrom` aceita IDs de usuário Matrix completos (exemplo: `@user:server`). O assistente resolve nomes de exibição para IDs quando a busca no diretório encontra uma única correspondência exata.

## Salas (grupos)

- Padrão: `channels.matrix.groupPolicy = "allowlist"` (com menção obrigatória). Use `channels.defaults.groupPolicy` para sobrescrever o padrão quando não definido.
- Coloque salas na lista de permissões com `channels.matrix.groups` (IDs ou aliases de sala; nomes são resolvidos para IDs quando a busca no diretório encontra uma única correspondência exata):

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- `requireMention: false` habilita resposta automática nessa sala.
- `groups."*"` pode definir padrões para exigência de menção entre salas.
- `groupAllowFrom` restringe quais remetentes podem acionar o bot em salas (IDs Matrix completos).
- Listas de permissões por sala `users` podem restringir ainda mais remetentes dentro de uma sala específica (use IDs Matrix completos).
- O assistente de configuração solicita listas de permissões de salas (IDs, aliases ou nomes) e resolve nomes apenas em uma correspondência exata e única.
- Na inicialização, o OpenClaw resolve nomes de sala/usuário nas listas de permissões para IDs e registra o mapeamento; entradas não resolvidas são ignoradas na correspondência de listas de permissões.
- Convites são aceitos automaticamente por padrão; controle com `channels.matrix.autoJoin` e `channels.matrix.autoJoinAllowlist`.
- Para permitir **nenhuma sala**, defina `channels.matrix.groupPolicy: "disabled"` (ou mantenha a lista de permissões vazia).
- Chave legada: `channels.matrix.rooms` (mesma estrutura que `groups`).

## Threads

- Encadeamento de respostas é suportado.
- `channels.matrix.threadReplies` controla se as respostas permanecem em threads:
  - `off`, `inbound` (padrão), `always`
- `channels.matrix.replyToMode` controla os metadados de resposta quando não responde em uma thread:
  - `off` (padrão), `first`, `all`

## Capacidades

| Funcionalidade    | Status                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Mensagens diretas | ✅ Suportado                                                                                                                    |
| Ambientes         | ✅ Suportado                                                                                                                    |
| Threads           | ✅ Suportado                                                                                                                    |
| Mídia             | ✅ Suportado                                                                                                                    |
| E2EE              | ✅ Suportado (módulo de crypto necessário)                                                                   |
| Reações           | ✅ Suportado (enviar/ler via ferramentas)                                                                    |
| Enquetes          | ✅ Envio suportado; inícios de enquete recebidos são convertidos em texto (respostas/finalizações ignoradas) |
| Localização       | ✅ Suportado (URI geo; altitude ignorada)                                                                    |
| Comandos nativos  | ✅ Suportado                                                                                                                    |

## Solução de problemas

Execute esta sequência primeiro:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Depois confirme o estado de pareamento de DMs, se necessário:

```bash
openclaw pairing list matrix
```

Falhas comuns:

- Logado, mas mensagens de salas ignoradas: sala bloqueada por `groupPolicy` ou lista de permissões de salas.
- DMs ignoradas: remetente aguardando aprovação quando `channels.matrix.dm.policy="pairing"`.
- Falha em salas criptografadas: suporte a crypto ou incompatibilidade nas configurações de criptografia.

Para fluxo de triagem: [/channels/troubleshooting](/channels/troubleshooting).

## Referência de configuração (Matrix)

Configuração completa: [Configuração](/gateway/configuration)

Opções do provedor:

- `channels.matrix.enabled`: habilitar/desabilitar a inicialização do canal.
- `channels.matrix.homeserver`: URL do homeserver.
- `channels.matrix.userId`: ID do usuário Matrix (opcional com token de acesso).
- `channels.matrix.accessToken`: token de acesso.
- `channels.matrix.password`: senha para login (token armazenado).
- `channels.matrix.deviceName`: nome de exibição do dispositivo.
- `channels.matrix.encryption`: habilitar E2EE (padrão: false).
- `channels.matrix.initialSyncLimit`: limite inicial de sincronização.
- `channels.matrix.threadReplies`: `off | inbound | always` (padrão: inbound).
- `channels.matrix.textChunkLimit`: tamanho do bloco de texto de saída (caracteres).
- `channels.matrix.chunkMode`: `length` (padrão) ou `newline` para dividir por linhas em branco (limites de parágrafo) antes do fracionamento por comprimento.
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (padrão: pareamento).
- `channels.matrix.dm.allowFrom`: lista de permissões de DM (IDs Matrix completos). `open` requer `"*"`. O assistente resolve nomes para IDs quando possível.
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (padrão: lista de permissões).
- `channels.matrix.groupAllowFrom`: remetentes permitidos para mensagens em grupo (IDs Matrix completos).
- `channels.matrix.allowlistOnly`: forçar regras de lista de permissões para DMs + salas.
- `channels.matrix.groups`: lista de permissões de grupo + mapa de configurações por sala.
- `channels.matrix.rooms`: lista/configuração legada de grupos.
- `channels.matrix.replyToMode`: modo de resposta para threads/tags.
- `channels.matrix.mediaMaxMb`: limite de mídia de entrada/saída (MB).
- `channels.matrix.autoJoin`: tratamento de convites (`always | allowlist | off`, padrão: sempre).
- `channels.matrix.autoJoinAllowlist`: IDs/aliases de salas permitidos para auto-join.
- `channels.matrix.actions`: controle de ferramentas por ação (reações/mensagens/pins/memberInfo/channelInfo).
