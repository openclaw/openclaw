---
summary: "Contexto: o que o modelo vê, como é construído e como inspecioná-lo"
read_when:
  - Você quer entender o que "contexto" significa em OpenClaw
  - Você está debugando por que o modelo "sabe" algo (ou esqueceu)
  - Você quer reduzir overhead de contexto (/context, /status, /compact)
title: "Contexto"
---

# Contexto

"Contexto" é **tudo que OpenClaw envia para o modelo em uma execução**. É limitado pela **janela de contexto** do modelo (limite de token).

Modelo mental iniciante:

- **System prompt** (construído por OpenClaw): regras, ferramentas, lista de skills, tempo/runtime e arquivos de workspace injetados.
- **Histórico de conversa**: suas mensagens + mensagens do assistente para esta sessão.
- **Chamadas de ferramentas/resultados + anexos**: saída de comando, leituras de arquivo, imagens/áudio, etc.

Contexto _não é a mesma coisa_ que "memória": memória pode ser armazenada em disco e recarregada mais tarde; contexto é o que está dentro da janela atual do modelo.

## Início rápido (inspeção de contexto)

- `/status` → visualização rápida "quão cheio está minha janela?" + configurações de sessão.
- `/context list` → o que está injetado + tamanhos aproximados (por arquivo + totais).
- `/context detail` → breakdown mais profundo: por arquivo, tamanhos de esquema por ferramenta, tamanhos de entrada por skill e tamanho de prompt do sistema.
- `/usage tokens` → anexar rodapé de uso por resposta a respostas normais.
- `/compact` → resumir histórico mais antigo em uma entrada compacta para liberar espaço de janela.

Veja também: [Comandos Slash](/tools/slash-commands), [Uso de token & custos](/reference/token-use), [Compactação](/pt-BR/concepts/compaction).

## Saída de exemplo

Valores variam por modelo, provedor, política de ferramenta e o que está em seu workspace.

### `/context list`

```
🧠 Context breakdown
Workspace: <workspaceDir>
Bootstrap max/file: 20,000 chars
Sandbox: mode=non-main sandboxed=false
System prompt (run): 38,412 chars (~9,603 tok) (Project Context 23,901 chars (~5,976 tok))

Injected workspace files:
- AGENTS.md: OK | raw 1,742 chars (~436 tok) | injected 1,742 chars (~436 tok)
- SOUL.md: OK | raw 912 chars (~228 tok) | injected 912 chars (~228 tok)
- TOOLS.md: TRUNCATED | raw 54,210 chars (~13,553 tok) | injected 20,962 chars (~5,241 tok)
- IDENTITY.md: OK | raw 211 chars (~53 tok) | injected 211 chars (~53 tok)
- USER.md: OK | raw 388 chars (~97 tok) | injected 388 chars (~97 tok)
- HEARTBEAT.md: MISSING | raw 0 | injected 0
- BOOTSTRAP.md: OK | raw 0 chars (~0 tok) | injected 0 chars (~0 tok)

Skills list (system prompt text): 2,184 chars (~546 tok) (12 skills)
Tools: read, edit, write, exec, process, browser, message, sessions_send, …
Tool list (system prompt text): 1,032 chars (~258 tok)
Tool schemas (JSON): 31,988 chars (~7,997 tok) (counts toward context; not shown as text)
Tools: (same as above)

Session tokens (cached): 14,250 total / ctx=32,000
```

### `/context detail`

```
🧠 Context breakdown (detailed)
…
Top skills (prompt entry size):
- frontend-design: 412 chars (~103 tok)
- oracle: 401 chars (~101 tok)
… (+10 more skills)

Top tools (schema size):
- browser: 9,812 chars (~2,453 tok)
- exec: 6,240 chars (~1,560 tok)
… (+N more tools)
```

## O que conta para a janela de contexto

Tudo que o modelo recebe conta, incluindo:

- System prompt (todas as seções).
- Histórico de conversa.
- Chamadas de ferramenta + resultados de ferramenta.
- Anexos/transcrições (imagens/áudio/arquivos).
- Resumos de compactação e artefatos de pruning.
- Wrappers de provedor ou headers ocultos (não visíveis, ainda contados).

## Como OpenClaw constrói o system prompt

O system prompt é **propriedade do OpenClaw** e reconstruído cada execução. Inclui:

- Lista de ferramenta + descrições curtas.
- Lista de skills (apenas metadados; veja abaixo).
- Localização do workspace.
- Hora (UTC + hora do usuário convertida se configurada).
- Metadados de runtime (host/OS/model/thinking).
- Arquivos de bootstrap de workspace injetados sob **Project Context**.

Breakdown completo: [System Prompt](/pt-BR/concepts/system-prompt).

## Arquivos de workspace injetados (Project Context)

Por padrão, OpenClaw injeta um conjunto fixo de arquivos de workspace (se presentes):

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (primeira execução apenas)

Arquivos grandes são truncados por arquivo usando `agents.defaults.bootstrapMaxChars` (padrão `20000` chars). OpenClaw também impõe um cap total de injeção de bootstrap entre arquivos com `agents.defaults.bootstrapTotalMaxChars` (padrão `150000` chars). `/context` mostra tamanhos **brutos vs injetados** e se truncagem aconteceu.

## Skills: o que é injetado vs carregado sob demanda

O system prompt inclui uma **lista de skills** compacta (nome + descrição + localização). Esta lista tem overhead real.

Instruções de skill _não_ são incluídas por padrão. Espera-se que o modelo `read` o `SKILL.md` da skill **apenas quando necessário**.

## Ferramentas: existem dois custos

Ferramentas afetam contexto de duas formas:

1. **Texto de lista de ferramentas** no system prompt (o que você vê como "Tooling").
2. **Esquemas de ferramenta** (JSON). Estes são enviados ao modelo para que possa chamar ferramentas. Eles contam para contexto mesmo que você não veja como texto plano.

`/context detail` divide os maiores esquemas de ferramenta para que você veja o que domina.

## Comandos, diretivas e "atalhos inline"

Comandos slash são manipulados pelo Gateway. Existem alguns comportamentos diferentes:

- **Comandos autônomos**: uma mensagem que é apenas `/...` é executada como comando.
- **Diretivas**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/model`, `/queue` são removidos antes do modelo ver a mensagem.
  - Mensagens apenas de diretiva persistem configurações de sessão.
  - Diretivas inline em uma mensagem normal atuam como dicas por mensagem.
- **Atalhos inline** (apenas remetentes na lista de permissões): certos tokens `/...` dentro de uma mensagem normal podem ser executados imediatamente (exemplo: "hey /status"), e são removidos antes do modelo ver o texto restante.

Detalhes: [Comandos Slash](/tools/slash-commands).

## Sessões, compactação e pruning (o que persiste)

O que persiste entre mensagens depende do mecanismo:

- **Histórico normal** persiste na transcrição de sessão até ser compactado/podado por política.
- **Compactação** persiste um resumo na transcrição e mantém mensagens recentes intactas.
- **Pruning** remove resultados de ferramenta antigos do prompt _na memória_ para uma execução, mas não reescreve a transcrição.

Docs: [Sessão](/pt-BR/concepts/session), [Compactação](/pt-BR/concepts/compaction), [Session pruning](/pt-BR/concepts/session-pruning).

## O que `/context` realmente relata

`/context` prefere o relatório de system prompt **construído por execução** mais recente quando disponível:

- `System prompt (run)` = capturado da última execução incorporada (capaz de ferramenta) e persistido no armazenamento de sessão.
- `System prompt (estimate)` = computado na mosca quando nenhum relatório de execução existe (ou ao executar via um backend CLI que não gera o relatório).

De qualquer forma, relata tamanhos e principais contribuidores; não **despeja** o prompt do sistema completo ou esquemas de ferramenta.
