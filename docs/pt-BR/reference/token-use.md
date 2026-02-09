---
summary: "Como o OpenClaw constrói o contexto do prompt e relata uso de tokens + custos"
read_when:
  - Ao explicar uso de tokens, custos ou janelas de contexto
  - Ao depurar crescimento de contexto ou comportamento de compactação
title: "Uso de tokens e custos"
---

# Uso de tokens e custos

O OpenClaw rastreia **tokens**, não caracteres. Tokens são específicos do modelo, mas a maioria
dos modelos no estilo OpenAI tem uma média de ~4 caracteres por token em texto em inglês.

## Como o prompt de sistema é construído

O OpenClaw monta seu próprio prompt de sistema a cada execução. Ele inclui:

- Lista de ferramentas + descrições curtas
- Lista de Skills (apenas metadados; as instruções são carregadas sob demanda com `read`)
- Instruções de autoatualização
- Workspace + arquivos de bootstrap (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` quando novos). Arquivos grandes são truncados por `agents.defaults.bootstrapMaxChars` (padrão: 20000).
- Hora (UTC + fuso horário do usuário)
- Tags de resposta + comportamento de heartbeat
- Metadados de runtime (host/OS/modelo/thinking)

Veja o detalhamento completo em [System Prompt](/concepts/system-prompt).

## O que conta na janela de contexto

Tudo o que o modelo recebe conta para o limite de contexto:

- Prompt de sistema (todas as seções listadas acima)
- Histórico da conversa (mensagens do usuário + do assistente)
- Chamadas de ferramentas e resultados das ferramentas
- Anexos/transcrições (imagens, áudio, arquivos)
- Resumos de compactação e artefatos de poda
- Wrappers do provedor ou cabeçalhos de segurança (não visíveis, mas ainda contabilizados)

Para um detalhamento prático (por arquivo injetado, ferramentas, Skills e tamanho do prompt de sistema), use `/context list` ou `/context detail`. Veja [Context](/concepts/context).

## Como ver o uso atual de tokens

Use estes comandos no chat:

- `/status` → **cartão de status rico em emojis** com o modelo da sessão, uso de contexto,
  tokens de entrada/saída da última resposta e **custo estimado** (apenas chave de API).
- `/usage off|tokens|full` → adiciona um **rodapé de uso por resposta** a cada resposta.
  - Persiste por sessão (armazenado como `responseUsage`).
  - Autenticação OAuth **oculta o custo** (apenas tokens).
- `/usage cost` → mostra um resumo local de custos a partir dos logs da sessão do OpenClaw.

Outras superfícies:

- **TUI/Web TUI:** `/status` + `/usage` são suportados.
- **CLI:** `openclaw status --usage` e `openclaw channels list` mostram
  janelas de cota do provedor (não custos por resposta).

## Estimativa de custos (quando exibida)

Os custos são estimados a partir da configuração de preços do seu modelo:

```
models.providers.<provider>.models[].cost
```

Estes são **USD por 1M de tokens** para `input`, `output`, `cacheRead` e
`cacheWrite`. Se o preço estiver ausente, o OpenClaw mostra apenas os tokens. Tokens OAuth
nunca mostram custo em dólares.

## TTL do cache e impacto da poda

O cache de prompt do provedor se aplica apenas dentro da janela de TTL do cache. O OpenClaw pode
opcionalmente executar **poda por cache-ttl**: ele poda a sessão quando o TTL do cache
expira e, em seguida, redefine a janela de cache para que as solicitações subsequentes possam reutilizar o
contexto recém-cacheado em vez de recachear todo o histórico. Isso mantém os custos de escrita de cache
mais baixos quando uma sessão fica ociosa além do TTL.

Configure isso em [Gateway configuration](/gateway/configuration) e veja os
detalhes de comportamento em [Session pruning](/concepts/session-pruning).

O heartbeat pode manter o cache **aquecido** durante intervalos de inatividade. Se o TTL de cache do seu modelo
for `1h`, definir o intervalo de heartbeat logo abaixo disso (por exemplo, `55m`) pode evitar
recachear todo o prompt, reduzindo os custos de escrita de cache.

Para preços da API Anthropic, leituras de cache são significativamente mais baratas do que tokens de entrada,
enquanto gravações de cache são cobradas com um multiplicador maior. Veja os preços de cache de prompt da Anthropic
para as taxas e multiplicadores de TTL mais recentes:
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### Exemplo: manter o cache de 1h aquecido com heartbeat

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

## Dicas para reduzir a pressão de tokens

- Use `/compact` para resumir sessões longas.
- Corte saídas grandes de ferramentas nos seus workflows.
- Mantenha descrições de Skills curtas (a lista de Skills é injetada no prompt).
- Prefira modelos menores para trabalhos verbosos e exploratórios.

Veja [Skills](/tools/skills) para a fórmula exata de overhead da lista de Skills.
