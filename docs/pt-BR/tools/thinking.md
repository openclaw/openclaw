---
summary: "Sintaxe de diretiva para /think + /verbose e como elas afetam o raciocínio do modelo"
read_when:
  - Ajustar a análise de diretivas de thinking ou verbose ou os padrões
title: "Níveis de Thinking"
---

# Níveis de Thinking (diretivas /think)

## O que faz

- Diretiva inline em qualquer corpo de entrada: `/t <level>`, `/think:<level>` ou `/thinking <level>`.
- Níveis (aliases): `off | minimal | low | medium | high | xhigh` (somente modelos GPT-5.2 + Codex)
  - minimal → “think”
  - low → “think hard”
  - medium → “think harder”
  - high → “ultrathink” (orçamento máximo)
  - xhigh → “ultrathink+” (somente modelos GPT-5.2 + Codex)
  - `x-high`, `x_high`, `extra-high`, `extra high` e `extra_high` mapeiam para `xhigh`.
  - `highest`, `max` mapeiam para `high`.
- Notas do provedor:
  - Z.AI (`zai/*`) oferece suporte apenas a thinking binário (`on`/`off`). Qualquer nível não-`off` é tratado como `on` (mapeado para `low`).

## Ordem de resolução

1. Diretiva inline na mensagem (aplica-se apenas àquela mensagem).
2. Substituição da sessão (definida ao enviar uma mensagem apenas com a diretiva).
3. Padrão global (`agents.defaults.thinkingDefault` na configuração).
4. Fallback: low para modelos com capacidade de raciocínio; off caso contrário.

## Definir um padrão da sessão

- Envie uma mensagem que seja **apenas** a diretiva (espaços em branco são permitidos), por exemplo, `/think:medium` ou `/t high`.
- Isso permanece para a sessão atual (por remetente, por padrão); é limpo por `/think:off` ou por redefinição de inatividade da sessão.
- Uma resposta de confirmação é enviada (`Thinking level set to high.` / `Thinking disabled.`). Se o nível for inválido (por exemplo, `/thinking big`), o comando é rejeitado com uma dica e o estado da sessão permanece inalterado.
- Envie `/think` (ou `/think:`) sem argumento para ver o nível de thinking atual.

## Aplicação por agente

- **Pi incorporado**: o nível resolvido é passado para o runtime do agente Pi em processo.

## Diretivas de verbose (/verbose ou /v)

- Níveis: `on` (minimal) | `full` | `off` (padrão).
- Mensagem apenas com a diretiva alterna o verbose da sessão e responde `Verbose logging enabled.` / `Verbose logging disabled.`; níveis inválidos retornam uma dica sem alterar o estado.
- `/verbose off` armazena uma substituição explícita da sessão; limpe-a pela UI de Sessões escolhendo `inherit`.
- A diretiva inline afeta apenas aquela mensagem; padrões de sessão/globais se aplicam caso contrário.
- Envie `/verbose` (ou `/verbose:`) sem argumento para ver o nível de verbose atual.
- Quando verbose está ativado, agentes que emitem resultados estruturados de ferramentas (Pi, outros agentes JSON) enviam cada chamada de ferramenta de volta como sua própria mensagem apenas de metadados, prefixada com `<emoji> <tool-name>: <arg>` quando disponível (caminho/comando). Esses resumos de ferramentas são enviados assim que cada ferramenta inicia (bolhas separadas), não como deltas de streaming.
- Quando verbose está `full`, as saídas das ferramentas também são encaminhadas após a conclusão (bolha separada, truncada a um comprimento seguro). Se voce alternar `/verbose on|full|off` enquanto uma execução está em andamento, as bolhas de ferramentas subsequentes respeitam a nova configuração.

## Visibilidade de raciocínio (/reasoning)

- Níveis: `on|off|stream`.
- Mensagem apenas com a diretiva alterna se blocos de thinking são exibidos nas respostas.
- Quando ativado, o raciocínio é enviado como uma **mensagem separada** prefixada com `Reasoning:`.
- `stream` (somente Telegram): transmite o raciocínio para a bolha de rascunho do Telegram enquanto a resposta está sendo gerada e, em seguida, envia a resposta final sem raciocínio.
- Alias: `/reason`.
- Envie `/reasoning` (ou `/reasoning:`) sem argumento para ver o nível de raciocínio atual.

## Relacionado

- A documentação do modo Elevated está em [Modo Elevated](/tools/elevated).

## Heartbeats

- O corpo da sonda de heartbeat é o prompt de heartbeat configurado (padrão: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Diretivas inline em uma mensagem de heartbeat se aplicam normalmente (mas evite alterar padrões de sessão a partir de heartbeats).
- A entrega de heartbeat usa por padrão apenas a carga final. Para também enviar a mensagem separada `Reasoning:` (quando disponível), defina `agents.defaults.heartbeat.includeReasoning: true` ou por agente `agents.list[].heartbeat.includeReasoning: true`.

## UI de chat web

- O seletor de thinking do chat web espelha o nível armazenado da sessão a partir do armazenamento/configuração da sessão de entrada quando a página carrega.
- Escolher outro nível aplica-se apenas à próxima mensagem (`thinkingOnce`); após o envio, o seletor retorna ao nível da sessão armazenado.
- Para alterar o padrão da sessão, envie uma diretiva `/think:<level>` (como antes); o seletor refletirá isso após o próximo recarregamento.
