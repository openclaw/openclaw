---
summary: "Comandos de barra: texto vs nativo, configuração e comandos compatíveis"
read_when:
  - Usando ou configurando comandos de chat
  - Depurando roteamento de comandos ou permissões
title: "Comandos de barra"
---

# Comandos de barra

Os comandos são tratados pelo Gateway. A maioria dos comandos deve ser enviada como uma mensagem **independente** que começa com `/`.
O comando de chat bash exclusivo do host usa `! <cmd>` (com `/bash <cmd>` como alias).

Há dois sistemas relacionados:

- **Comandos**: mensagens `/...` independentes.
- **Diretivas**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - As diretivas são removidas da mensagem antes que o modelo a veja.
  - Em mensagens de chat normais (não apenas diretivas), elas são tratadas como “dicas inline” e **não** persistem as configurações da sessão.
  - Em mensagens somente com diretivas (a mensagem contém apenas diretivas), elas persistem na sessão e respondem com um reconhecimento.
  - As diretivas só são aplicadas para **remetentes autorizados** (listas de permissões/pareamento do canal mais `commands.useAccessGroups`).
    Remetentes não autorizados veem as diretivas tratadas como texto simples.

Há também alguns **atalhos inline** (somente remetentes na lista de permissões/autorizados): `/help`, `/commands`, `/status`, `/whoami` (`/id`).
Eles executam imediatamente, são removidos antes que o modelo veja a mensagem, e o texto restante continua pelo fluxo normal.

## Configuração

```json5
{
  commands: {
    native: "auto",
    nativeSkills: "auto",
    text: true,
    bash: false,
    bashForegroundMs: 2000,
    config: false,
    debug: false,
    restart: false,
    useAccessGroups: true,
  },
}
```

- `commands.text` (padrão `true`) habilita a análise de `/...` em mensagens de chat.
  - Em superfícies sem comandos nativos (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams), comandos de texto ainda funcionam mesmo se você definir isso como `false`.
- `commands.native` (padrão `"auto"`) registra comandos nativos.
  - Auto: ligado para Discord/Telegram; desligado para Slack (até você adicionar comandos de barra); ignorado para provedores sem suporte nativo.
  - Defina `channels.discord.commands.native`, `channels.telegram.commands.native` ou `channels.slack.commands.native` para substituir por provedor (bool ou `"auto"`).
  - `false` limpa comandos registrados anteriormente no Discord/Telegram na inicialização. Comandos do Slack são gerenciados no app do Slack e não são removidos automaticamente.
- `commands.nativeSkills` (padrão `"auto"`) registra comandos de **skill** nativamente quando compatível.
  - Auto: ligado para Discord/Telegram; desligado para Slack (o Slack exige criar um comando de barra por skill).
  - Defina `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills` ou `channels.slack.commands.nativeSkills` para substituir por provedor (bool ou `"auto"`).
- `commands.bash` (padrão `false`) habilita `! <cmd>` para executar comandos de shell do host (`/bash <cmd>` é um alias; requer listas de permissões `tools.elevated`).
- `commands.bashForegroundMs` (padrão `2000`) controla quanto tempo o bash espera antes de alternar para o modo em segundo plano (`0` envia imediatamente para segundo plano).
- `commands.config` (padrão `false`) habilita `/config` (leitura/gravação de `openclaw.json`).
- `commands.debug` (padrão `false`) habilita `/debug` (substituições apenas em tempo de execução).
- `commands.useAccessGroups` (padrão `true`) aplica listas de permissões/políticas para comandos.

## Lista de comandos

Texto + nativo (quando habilitado):

- `/help`
- `/commands`
- `/skill <name> [input]` (executar uma skill pelo nome)
- `/status` (mostrar status atual; inclui uso/cota do provedor para o provedor de modelo atual quando disponível)
- `/allowlist` (listar/adicionar/remover entradas da lista de permissões)
- `/approve <id> allow-once|allow-always|deny` (resolver prompts de aprovação de execução)
- `/context [list|detail|json]` (explicar “contexto”; `detail` mostra tamanho por arquivo + por ferramenta + por skill + prompt do sistema)
- `/whoami` (mostrar seu id de remetente; alias: `/id`)
- `/subagents list|stop|log|info|send` (inspecionar, parar, registrar logs ou enviar mensagens para execuções de subagentes da sessão atual)
- `/config show|get|set|unset` (persistir configuração em disco, apenas proprietário; requer `commands.config: true`)
- `/debug show|set|unset|reset` (substituições em tempo de execução, apenas proprietário; requer `commands.debug: true`)
- `/usage off|tokens|full|cost` (rodapé de uso por resposta ou resumo local de custos)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (controlar TTS; veja [/tts](/tts))
  - Discord: o comando nativo é `/voice` (o Discord reserva `/tts`); o texto `/tts` ainda funciona.
- `/stop`
- `/restart`
- `/dock-telegram` (alias: `/dock_telegram`) (alternar respostas para o Telegram)
- `/dock-discord` (alias: `/dock_discord`) (alternar respostas para o Discord)
- `/dock-slack` (alias: `/dock_slack`) (alternar respostas para o Slack)
- `/activation mention|always` (somente grupos)
- `/send on|off|inherit` (apenas proprietário)
- `/reset` ou `/new [model]` (dica opcional de modelo; o restante é repassado)
- `/think <off|minimal|low|medium|high|xhigh>` (escolhas dinâmicas por modelo/provedor; aliases: `/thinking`, `/t`)
- `/verbose on|full|off` (alias: `/v`)
- `/reasoning on|off|stream` (alias: `/reason`; quando ligado, envia uma mensagem separada prefixada com `Reasoning:`; `stream` = rascunho apenas do Telegram)
- `/elevated on|off|ask|full` (alias: `/elev`; `full` ignora aprovações de execução)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (enviar `/exec` para mostrar o atual)
- `/model <name>` (alias: `/models`; ou `/<alias>` a partir de `agents.defaults.models.*.alias`)
- `/queue <mode>` (mais opções como `debounce:2s cap:25 drop:summarize`; envie `/queue` para ver as configurações atuais)
- `/bash <command>` (somente host; alias para `! <command>`; requer listas de permissões `commands.bash: true` + `tools.elevated`)

Somente texto:

- `/compact [instructions]` (veja [/concepts/compaction](/concepts/compaction))
- `! <command>` (somente host; um por vez; use `!poll` + `!stop` para trabalhos de longa duração)
- `!poll` (verificar saída/status; aceita `sessionId` opcional; `/bash poll` também funciona)
- `!stop` (parar o trabalho bash em execução; aceita `sessionId` opcional; `/bash stop` também funciona)

Notas:

- Os comandos aceitam um `:` opcional entre o comando e os argumentos (por exemplo, `/think: high`, `/send: on`, `/help:`).
- `/new <model>` aceita um alias de modelo, `provider/model` ou um nome de provedor (correspondência aproximada); se não houver correspondência, o texto é tratado como o corpo da mensagem.
- Para a divisão completa de uso por provedor, use `openclaw status --usage`.
- `/allowlist add|remove` requer `commands.config=true` e respeita `configWrites` do canal.
- `/usage` controla o rodapé de uso por resposta; `/usage cost` imprime um resumo local de custos a partir dos logs de sessão do OpenClaw.
- `/restart` vem desativado por padrão; defina `commands.restart: true` para habilitá-lo.
- `/verbose` é destinado a depuração e visibilidade extra; mantenha **desligado** no uso normal.
- `/reasoning` (e `/verbose`) são arriscados em configurações de grupo: podem revelar raciocínio interno ou saída de ferramentas que você não pretendia expor. Prefira deixá-los desligados, especialmente em chats de grupo.
- **Caminho rápido:** mensagens somente de comando de remetentes na lista de permissões são tratadas imediatamente (ignoram fila + modelo).
- **Controle por menção em grupo:** mensagens somente de comando de remetentes na lista de permissões ignoram requisitos de menção.
- **Atalhos inline (somente remetentes na lista de permissões):** certos comandos também funcionam quando incorporados em uma mensagem normal e são removidos antes que o modelo veja o texto restante.
  - Exemplo: `hey /status` aciona uma resposta de status, e o texto restante continua pelo fluxo normal.
- Atualmente: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- Mensagens somente de comando não autorizadas são ignoradas silenciosamente, e tokens inline `/...` são tratados como texto simples.
- **Comandos de skill:** skills `user-invocable` são expostas como comandos de barra. Os nomes são sanitizados para `a-z0-9_` (máx. 32 caracteres); colisões recebem sufixos numéricos (por exemplo, `_2`).
  - `/skill <name> [input]` executa uma skill pelo nome (útil quando limites de comandos nativos impedem comandos por skill).
  - Por padrão, comandos de skill são encaminhados ao modelo como uma solicitação normal.
  - Skills podem opcionalmente declarar `command-dispatch: tool` para rotear o comando diretamente para uma ferramenta (determinístico, sem modelo).
  - Exemplo: `/prose` (plugin OpenProse) — veja [OpenProse](/prose).
- **Argumentos de comandos nativos:** o Discord usa autocomplete para opções dinâmicas (e menus de botão quando você omite argumentos obrigatórios). Telegram e Slack mostram um menu de botões quando um comando oferece escolhas e você omite o argumento.

## Superfícies de uso (o que aparece onde)

- **Uso/cota do provedor** (exemplo: “Claude 80% restante”) aparece em `/status` para o provedor de modelo atual quando o rastreamento de uso está habilitado.
- **Tokens/custo por resposta** é controlado por `/usage off|tokens|full` (anexado às respostas normais).
- `/model status` trata de **modelos/autenticação/endpoints**, não de uso.

## Seleção de modelo (`/model`)

`/model` é implementado como uma diretiva.

Exemplos:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

Notas:

- `/model` e `/model list` mostram um seletor compacto e numerado (família do modelo + provedores disponíveis).
- `/model <#>` seleciona a partir desse seletor (e prefere o provedor atual quando possível).
- `/model status` mostra a visão detalhada, incluindo o endpoint do provedor configurado (`baseUrl`) e o modo de API (`api`) quando disponível.

## Debug overrides

`/debug` permite definir substituições de configuração **apenas em tempo de execução** (memória, não disco). Apenas proprietário. Desativado por padrão; habilite com `commands.debug: true`.

Exemplos:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Notas:

- As substituições se aplicam imediatamente a novas leituras de configuração, mas **não** gravam em `openclaw.json`.
- Use `/debug reset` para limpar todas as substituições e retornar à configuração em disco.

## Atualizações de configuração

`/config` grava na sua configuração em disco (`openclaw.json`). Apenas proprietário. Desativado por padrão; habilite com `commands.config: true`.

Exemplos:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

Notas:

- A configuração é validada antes da gravação; alterações inválidas são rejeitadas.
- Atualizações `/config` persistem entre reinicializações.

## Notas de superfície

- **Comandos de texto** executam na sessão normal de chat (DMs compartilham `main`, grupos têm sua própria sessão).
- **Comandos nativos** usam sessões isoladas:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (prefixo configurável via `channels.slack.slashCommand.sessionPrefix`)
  - Telegram: `telegram:slash:<userId>` (direciona para a sessão do chat via `CommandTargetSessionKey`)
- **`/stop`** direciona a sessão de chat ativa para que possa abortar a execução atual.
- **Slack:** `channels.slack.slashCommand` ainda é compatível para um único comando no estilo `/openclaw`. Se você habilitar `commands.native`, deve criar um comando de barra do Slack por comando embutido (mesmos nomes que `/help`). Menus de argumentos de comando para o Slack são entregues como botões efêmeros do Block Kit.
