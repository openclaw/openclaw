---
summary: "Interface de Terminal (TUI): conecte-se ao Gateway a partir de qualquer máquina"
read_when:
  - Você quer um passo a passo amigável para iniciantes do TUI
  - Você precisa da lista completa de recursos, comandos e atalhos do TUI
title: "TUI"
---

# TUI (Interface de Terminal)

## Início rápido

1. Inicie o Gateway.

```bash
openclaw gateway
```

2. Abra o TUI.

```bash
openclaw tui
```

3. Digite uma mensagem e pressione Enter.

Gateway remoto:

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

Use `--password` se o seu Gateway usar autenticação por senha.

## O que você vê

- Cabeçalho: URL de conexão, agente atual, sessão atual.
- Log do chat: mensagens do usuário, respostas do assistente, avisos do sistema, cartões de ferramentas.
- Linha de status: estado de conexão/execução (conectando, executando, streaming, ocioso, erro).
- Rodapé: estado da conexão + agente + sessão + modelo + pensar/verboso/raciocínio + contagens de tokens + entrega.
- Entrada: editor de texto com preenchimento automático.

## Modelo mental: agentes + sessões

- Agentes são slugs únicos (por exemplo, `main`, `research`). O Gateway expõe a lista.
- Sessões pertencem ao agente atual.
- As chaves de sessão são armazenadas como `agent:<agentId>:<sessionKey>`.
  - Se você digitar `/session main`, o TUI expande para `agent:<currentAgent>:main`.
  - Se você digitar `/session agent:other:main`, você muda explicitamente para a sessão desse agente.
- Escopo da sessão:
  - `per-sender` (padrão): cada agente tem várias sessões.
  - `global`: o TUI sempre usa a sessão `global` (o seletor pode ficar vazio).
- O agente + sessão atuais estão sempre visíveis no rodapé.

## Envio + entrega

- As mensagens são enviadas ao Gateway; a entrega aos provedores fica desativada por padrão.
- Ative a entrega:
  - `/deliver on`
  - ou o painel de Configurações
  - ou inicie com `openclaw tui --deliver`

## Seletores + sobreposições

- Seletor de modelo: lista os modelos disponíveis e define a substituição da sessão.
- Seletor de agente: escolha um agente diferente.
- Seletor de sessão: mostra apenas as sessões do agente atual.
- Configurações: alterna entrega, expansão da saída de ferramentas e visibilidade de pensamento.

## Atalhos de teclado

- Enter: enviar mensagem
- Esc: abortar execução ativa
- Ctrl+C: limpar entrada (pressione duas vezes para sair)
- Ctrl+D: sair
- Ctrl+L: seletor de modelo
- Ctrl+G: seletor de agente
- Ctrl+P: seletor de sessão
- Ctrl+O: alternar expansão da saída de ferramentas
- Ctrl+T: alternar visibilidade de pensamento (recarrega o histórico)

## Comandos com barra

Núcleo:

- `/help`
- `/status`
- `/agent <id>` (ou `/agents`)
- `/session <key>` (ou `/sessions`)
- `/model <provider/model>` (ou `/models`)

Controles de sessão:

- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>` (alias: `/elev`)
- `/activation <mention|always>`
- `/deliver <on|off>`

Ciclo de vida da sessão:

- `/new` ou `/reset` (redefine a sessão)
- `/abort` (aborta a execução ativa)
- `/settings`
- `/exit`

Outros comandos com barra do Gateway (por exemplo, `/context`) são encaminhados ao Gateway e mostrados como saída do sistema. Veja [Slash commands](/tools/slash-commands).

## Comandos locais do shell

- Prefixe uma linha com `!` para executar um comando local do shell no host do TUI.
- O TUI solicita uma vez por sessão para permitir a execução local; recusar mantém `!` desativado para a sessão.
- Os comandos são executados em um shell novo e não interativo no diretório de trabalho do TUI (sem `cd`/env persistente).
- Um `!` isolado é enviado como uma mensagem normal; espaços à esquerda não disparam execução local.

## Saída de ferramentas

- Chamadas de ferramentas aparecem como cartões com argumentos + resultados.
- Ctrl+O alterna entre visualizações recolhida/expandida.
- Enquanto as ferramentas executam, atualizações parciais fazem streaming no mesmo cartão.

## Histórico + streaming

- Ao conectar, o TUI carrega o histórico mais recente (padrão: 200 mensagens).
- Respostas em streaming são atualizadas no lugar até serem finalizadas.
- O TUI também escuta eventos de ferramentas do agente para cartões de ferramentas mais ricos.

## Detalhes da conexão

- O TUI se registra no Gateway como `mode: "tui"`.
- Reconexões mostram uma mensagem do sistema; lacunas de eventos aparecem no log.

## Opções

- `--url <url>`: URL do WebSocket do Gateway (padrão: configuração ou `ws://127.0.0.1:<port>`)
- `--token <token>`: token do Gateway (se necessário)
- `--password <password>`: senha do Gateway (se necessário)
- `--session <key>`: chave de sessão (padrão: `main`, ou `global` quando o escopo é global)
- `--deliver`: entregar respostas do assistente ao provedor (padrão: desligado)
- `--thinking <level>`: substituir o nível de pensamento para envios
- `--timeout-ms <ms>`: tempo limite do agente em ms (padrão: `agents.defaults.timeoutSeconds`)

Nota: ao definir `--url`, o TUI não recorre à configuração nem às credenciais de ambiente.
Passe `--token` ou `--password` explicitamente. A ausência de credenciais explícitas é um erro.

## Solução de problemas

Sem saída após enviar uma mensagem:

- Execute `/status` no TUI para confirmar que o Gateway está conectado e ocioso/ocupado.
- Verifique os logs do Gateway: `openclaw logs --follow`.
- Confirme que o agente consegue executar: `openclaw status` e `openclaw models status`.
- Se você espera mensagens em um canal de chat, habilite a entrega (`/deliver on` ou `--deliver`).
- `--history-limit <n>`: entradas de histórico a carregar (padrão: 200)

## Solução de problemas de conexão

- `disconnected`: garanta que o Gateway esteja em execução e que seus `--url/--token/--password` estejam corretos.
- Nenhum agente no seletor: verifique `openclaw agents list` e sua configuração de roteamento.
- Seletor de sessão vazio: você pode estar no escopo global ou ainda não ter sessões.
