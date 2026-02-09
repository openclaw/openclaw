---
summary: "Contexto: o que o modelo vê, como é construído e como inspecioná-lo"
read_when:
  - Você quer entender o que “contexto” significa no OpenClaw
  - Você está depurando por que o modelo “sabe” algo (ou esqueceu)
  - Você quer reduzir a sobrecarga de contexto (/context, /status, /compact)
title: "Contexto"
---

# Contexto

“Contexto” é **tudo o que o OpenClaw envia ao modelo para uma execução**. Ele é limitado pela **janela de contexto** do modelo (limite de tokens).

Modelo mental para iniciantes:

- **Prompt do sistema** (construído pelo OpenClaw): regras, ferramentas, lista de Skills, tempo/tempo de execução e arquivos do workspace injetados.
- **Histórico da conversa**: suas mensagens + as mensagens do assistente desta sessão.
- **Chamadas/resultados de ferramentas + anexos**: saída de comandos, leituras de arquivos, imagens/áudio etc.

Contexto _não é a mesma coisa_ que “memória”: a memória pode ser armazenada em disco e recarregada depois; contexto é o que está dentro da janela atual do modelo.

## Início rápido (inspecionar contexto)

- `/status` → visão rápida de “quão cheia está minha janela?” + configurações da sessão.
- `/context list` → o que é injetado + tamanhos aproximados (por arquivo + totais).
- `/context detail` → detalhamento mais profundo: por arquivo, tamanhos de esquemas por ferramenta, tamanhos de entradas por Skill e tamanho do prompt do sistema.
- `/usage tokens` → acrescenta um rodapé de uso por resposta às respostas normais.
- `/compact` → resume histórico mais antigo em uma entrada compacta para liberar espaço da janela.

Veja também: [Slash commands](/tools/slash-commands), [Uso de tokens e custos](/reference/token-use), [Compactação](/concepts/compaction).

## Exemplo de saída

Os valores variam por modelo, provedor, política de ferramentas e pelo que está no seu workspace.

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

Tudo o que o modelo recebe conta, incluindo:

- Prompt do sistema (todas as seções).
- Histórico da conversa.
- Chamadas de ferramentas + resultados de ferramentas.
- Anexos/transcrições (imagens/áudio/arquivos).
- Resumos de compactação e artefatos de poda.
- “Wrappers” do provedor ou cabeçalhos ocultos (não visíveis, ainda contam).

## Como o OpenClaw constrói o prompt do sistema

O prompt do sistema é **de propriedade do OpenClaw** e é reconstruído a cada execução. Ele inclui:

- Lista de ferramentas + descrições curtas.
- Lista de Skills (apenas metadados; veja abaixo).
- Localização do workspace.
- Hora (UTC + hora do usuário convertida, se configurado).
- Metadados de runtime (host/SO/modelo/raciocínio).
- Arquivos de bootstrap do workspace injetados em **Project Context**.

Detalhamento completo: [Prompt do sistema](/concepts/system-prompt).

## Arquivos do workspace injetados (Project Context)

Por padrão, o OpenClaw injeta um conjunto fixo de arquivos do workspace (se presentes):

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (apenas na primeira execução)

Arquivos grandes são truncados por arquivo usando `agents.defaults.bootstrapMaxChars` (padrão `20000` caracteres). `/context` mostra os tamanhos **brutos vs injetados** e se houve truncamento.

## Skills: o que é injetado vs carregado sob demanda

O prompt do sistema inclui uma **lista compacta de Skills** (nome + descrição + localização). Essa lista tem sobrecarga real.

As instruções das Skills _não_ são incluídas por padrão. Espera-se que o modelo `read` o `SKILL.md` da Skill **apenas quando necessário**.

## Ferramentas: existem dois custos

Ferramentas afetam o contexto de duas maneiras:

1. **Texto da lista de ferramentas** no prompt do sistema (o que você vê como “Tooling”).
2. **Esquemas de ferramentas** (JSON). Eles são enviados ao modelo para que ele possa chamar ferramentas. Eles contam para o contexto mesmo que você não os veja como texto simples.

`/context detail` detalha os maiores esquemas de ferramentas para que você veja o que domina.

## Comandos, diretivas e “atalhos inline”

Slash commands são tratados pelo Gateway. Existem alguns comportamentos diferentes:

- **Comandos independentes**: uma mensagem que é apenas `/...` executa como um comando.
- **Diretivas**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/model`, `/queue` são removidas antes de o modelo ver a mensagem.
  - Mensagens apenas com diretivas persistem as configurações da sessão.
  - Diretivas inline em uma mensagem normal atuam como dicas por mensagem.
- **Atalhos inline** (apenas remetentes na lista de permissões): certos tokens `/...` dentro de uma mensagem normal podem executar imediatamente (exemplo: “hey /status”) e são removidos antes de o modelo ver o texto restante.

Detalhes: [Slash commands](/tools/slash-commands).

## Sessões, compactação e poda (o que persiste)

O que persiste entre mensagens depende do mecanismo:

- **Histórico normal** persiste na transcrição da sessão até ser compactado/podado pela política.
- **Compactação** persiste um resumo na transcrição e mantém mensagens recentes intactas.
- **Poda** remove resultados antigos de ferramentas do prompt _em memória_ para uma execução, mas não reescreve a transcrição.

Docs: [Sessão](/concepts/session), [Compactação](/concepts/compaction), [Poda de sessão](/concepts/session-pruning).

## O que `/context` realmente reporta

`/context` prefere o relatório mais recente do prompt do sistema **construído na execução**, quando disponível:

- `System prompt (run)` = capturado da última execução incorporada (com capacidade de ferramentas) e persistido no armazenamento da sessão.
- `System prompt (estimate)` = calculado dinamicamente quando não existe relatório de execução (ou ao executar via um backend de CLI que não gera o relatório).

De qualquer forma, ele reporta tamanhos e principais contribuintes; **não** despeja o prompt do sistema completo nem os esquemas de ferramentas.
