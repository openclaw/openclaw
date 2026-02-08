---
summary: "Como funciona a memória do OpenClaw (arquivos do workspace + limpeza automática de memória)"
read_when:
  - Você quer o layout e o fluxo de trabalho dos arquivos de memória
  - Você quer ajustar a limpeza automática de memória antes da compactação
x-i18n:
  source_path: concepts/memory.md
  source_hash: e160dc678bb8fda2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:31:11Z
---

# Memória

A memória do OpenClaw é **Markdown simples no workspace do agente**. Os arquivos são a
fonte da verdade; o modelo só “lembra” do que é gravado em disco.

As ferramentas de busca de memória são fornecidas pelo plugin de memória ativo (padrão:
`memory-core`). Desative plugins de memória com `plugins.slots.memory = "none"`.

## Arquivos de memória (Markdown)

O layout padrão do workspace usa duas camadas de memória:

- `memory/YYYY-MM-DD.md`
  - Log diário (somente append).
  - Lê hoje + ontem no início da sessão.
- `MEMORY.md` (opcional)
  - Memória de longo prazo curada.
  - **Carregada apenas na sessão principal e privada** (nunca em contextos de grupo).

Esses arquivos ficam no workspace (`agents.defaults.workspace`, padrão
`~/.openclaw/workspace`). Veja [Agent workspace](/concepts/agent-workspace) para o layout completo.

## Quando escrever memória

- Decisões, preferências e fatos duráveis vão para `MEMORY.md`.
- Notas do dia a dia e contexto em andamento vão para `memory/YYYY-MM-DD.md`.
- Se alguém disser “lembre disso”, escreva (não mantenha apenas na RAM).
- Esta área ainda está evoluindo. Ajuda lembrar o modelo de armazenar memórias; ele saberá o que fazer.
- Se você quer que algo persista, **peça ao bot para escrever** na memória.

## Limpeza automática de memória (ping pré-compactação)

Quando uma sessão está **próxima da auto-compactação**, o OpenClaw dispara um **turno
agêntico silencioso** que lembra o modelo de escrever memória durável **antes** que o
contexto seja compactado. Os prompts padrão dizem explicitamente que o modelo _pode responder_,
mas normalmente `NO_REPLY` é a resposta correta para que o usuário nunca veja esse turno.

Isso é controlado por `agents.defaults.compaction.memoryFlush`:

```json5
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

Detalhes:

- **Limite suave**: a limpeza dispara quando a estimativa de tokens da sessão cruza
  `contextWindow - reserveTokensFloor - softThresholdTokens`.
- **Silencioso** por padrão: os prompts incluem `NO_REPLY` para que nada seja entregue.
- **Dois prompts**: um prompt de usuário mais um prompt de sistema anexam o lembrete.
- **Uma limpeza por ciclo de compactação** (rastreada em `sessions.json`).
- **O workspace precisa ser gravável**: se a sessão rodar em sandbox com
  `workspaceAccess: "ro"` ou `"none"`, a limpeza é ignorada.

Para o ciclo completo de compactação, veja
[Session management + compaction](/reference/session-management-compaction).

## Busca de memória vetorial

O OpenClaw pode construir um pequeno índice vetorial sobre `MEMORY.md` e `memory/*.md` para que
consultas semânticas encontrem notas relacionadas mesmo quando a redação difere.

Padrões:

- Ativado por padrão.
- Observa arquivos de memória para mudanças (com debounce).
- Usa embeddings remotos por padrão. Se `memorySearch.provider` não estiver definido, o OpenClaw seleciona automaticamente:
  1. `local` se um `memorySearch.local.modelPath` estiver configurado e o arquivo existir.
  2. `openai` se uma chave da OpenAI puder ser resolvida.
  3. `gemini` se uma chave do Gemini puder ser resolvida.
  4. `voyage` se uma chave da Voyage puder ser resolvida.
  5. Caso contrário, a busca de memória permanece desativada até ser configurada.
- O modo local usa node-llama-cpp e pode exigir `pnpm approve-builds`.
- Usa sqlite-vec (quando disponível) para acelerar a busca vetorial dentro do SQLite.

Embeddings remotos **exigem** uma chave de API para o provedor de embeddings. O OpenClaw
resolve chaves a partir de perfis de autenticação, `models.providers.*.apiKey` ou variáveis
de ambiente. O OAuth do Codex cobre apenas chat/completions e **não** atende
embeddings para busca de memória. Para Gemini, use `GEMINI_API_KEY` ou
`models.providers.google.apiKey`. Para Voyage, use `VOYAGE_API_KEY` ou
`models.providers.voyage.apiKey`. Ao usar um endpoint OpenAI-compatível personalizado,
defina `memorySearch.remote.apiKey` (e opcional `memorySearch.remote.headers`).

### Backend QMD (experimental)

Defina `memory.backend = "qmd"` para trocar o indexador SQLite embutido por
[QMD](https://github.com/tobi/qmd): um sidecar de busca local-first que combina
BM25 + vetores + reranking. O Markdown continua sendo a fonte da verdade; o OpenClaw
chama o QMD para recuperação. Pontos-chave:

**Pré-requisitos**

- Desativado por padrão. Opte por config (`memory.backend = "qmd"`).
- Instale a CLI do QMD separadamente (`bun install -g https://github.com/tobi/qmd` ou baixe
  um release) e garanta que o binário `qmd` esteja no `PATH` do gateway.
- O QMD precisa de um build do SQLite que permita extensões (`brew install sqlite` no
  macOS).
- O QMD roda totalmente local via Bun + `node-llama-cpp` e faz download automático de modelos
  GGUF do HuggingFace no primeiro uso (não é necessário um daemon Ollama separado).
- O gateway executa o QMD em um home XDG autocontido sob
  `~/.openclaw/agents/<agentId>/qmd/` definindo `XDG_CONFIG_HOME` e
  `XDG_CACHE_HOME`.
- Suporte a SO: macOS e Linux funcionam imediatamente após instalar Bun + SQLite.
  Windows é melhor suportado via WSL2.

**Como o sidecar roda**

- O gateway grava um home QMD autocontido sob
  `~/.openclaw/agents/<agentId>/qmd/` (config + cache + DB sqlite).
- Coleções são criadas via `qmd collection add` a partir de `memory.qmd.paths`
  (mais os arquivos de memória padrão do workspace), depois `qmd update` + `qmd embed` rodam
  no boot e em um intervalo configurável (`memory.qmd.update.interval`,
  padrão 5 m).
- A atualização no boot agora roda em segundo plano por padrão para não bloquear
  o início do chat; defina `memory.qmd.update.waitForBootSync = true` para manter o comportamento
  bloqueante anterior.
- As buscas rodam via `qmd query --json`. Se o QMD falhar ou o binário estiver ausente,
  o OpenClaw retorna automaticamente ao gerenciador SQLite embutido para que as ferramentas
  de memória continuem funcionando.
- O OpenClaw não expõe ajuste de batch-size de embeddings do QMD hoje; o comportamento de batch
  é controlado pelo próprio QMD.
- **A primeira busca pode ser lenta**: o QMD pode baixar modelos GGUF locais (reranker/expansão
  de consulta) na primeira execução de `qmd query`.
  - O OpenClaw define `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` automaticamente quando executa o QMD.
  - Se você quiser pré-baixar modelos manualmente (e aquecer o mesmo índice que o OpenClaw
    usa), execute uma consulta única com os diretórios XDG do agente.

    O estado do QMD do OpenClaw fica no seu **diretório de estado** (padrão `~/.openclaw`).
    Você pode apontar `qmd` para exatamente o mesmo índice exportando as mesmas variáveis XDG
    que o OpenClaw usa:

    ```bash
    # Pick the same state dir OpenClaw uses
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    if [ -d "$HOME/.moltbot" ] && [ ! -d "$HOME/.openclaw" ] \
      && [ -z "${OPENCLAW_STATE_DIR:-}" ]; then
      STATE_DIR="$HOME/.moltbot"
    fi

    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

    # (Optional) force an index refresh + embeddings
    qmd update
    qmd embed

    # Warm up / trigger first-time model downloads
    qmd query "test" -c memory-root --json >/dev/null 2>&1
    ```

**Superfície de configuração (`memory.qmd.*`)**

- `command` (padrão `qmd`): sobrescreve o caminho do executável.
- `includeDefaultMemory` (padrão `true`): indexa automaticamente `MEMORY.md` + `memory/**/*.md`.
- `paths[]`: adiciona diretórios/arquivos extras (`path`, opcional `pattern`, opcional
  estável `name`).
- `sessions`: opta por indexação de JSONL de sessão (`enabled`, `retentionDays`,
  `exportDir`).
- `update`: controla a cadência de atualização e execução de manutenção:
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`).
- `limits`: limita o payload de recall (`maxResults`, `maxSnippetChars`,
  `maxInjectedChars`, `timeoutMs`).
- `scope`: mesmo esquema de [`session.sendPolicy`](/gateway/configuration#session).
  O padrão é apenas DM (`deny` todos, `allow` chats diretos); afrouxe para expor
  resultados do QMD em grupos/canais.
- Trechos originados fora do workspace aparecem como
  `qmd/<collection>/<relative-path>` nos resultados de `memory_search`; `memory_get`
  entende esse prefixo e lê a partir da raiz da coleção QMD configurada.
- Quando `memory.qmd.sessions.enabled = true`, o OpenClaw exporta transcrições de sessão
  higienizadas (turnos de Usuário/Assistente) para uma coleção QMD dedicada sob
  `~/.openclaw/agents/<id>/qmd/sessions/`, para que `memory_search` possa relembrar
  conversas recentes sem tocar no índice SQLite embutido.
- Os trechos de `memory_search` agora incluem um rodapé `Source: <path#line>` quando
  `memory.citations` é `auto`/`on`; defina `memory.citations = "off"` para manter
  os metadados de caminho internos (o agente ainda recebe o caminho para
  `memory_get`, mas o texto do trecho omite o rodapé e o prompt de sistema
  alerta o agente para não citá-lo).

**Exemplo**

```json5
memory: {
  backend: "qmd",
  citations: "auto",
  qmd: {
    includeDefaultMemory: true,
    update: { interval: "5m", debounceMs: 15000 },
    limits: { maxResults: 6, timeoutMs: 4000 },
    scope: {
      default: "deny",
      rules: [{ action: "allow", match: { chatType: "direct" } }]
    },
    paths: [
      { name: "docs", path: "~/notes", pattern: "**/*.md" }
    ]
  }
}
```

**Citações e fallback**

- `memory.citations` se aplica independentemente do backend (`auto`/`on`/`off`).
- Quando `qmd` roda, marcamos `status().backend = "qmd"` para que os diagnósticos mostrem
  qual mecanismo serviu os resultados. Se o subprocesso do QMD sair ou a saída JSON não puder
  ser analisada, o gerenciador de busca registra um aviso e retorna o provedor embutido
  (embeddings Markdown existentes) até o QMD se recuperar.

### Caminhos de memória adicionais

Se você quiser indexar arquivos Markdown fora do layout padrão do workspace, adicione
caminhos explícitos:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

Notas:

- Os caminhos podem ser absolutos ou relativos ao workspace.
- Diretórios são varridos recursivamente por arquivos `.md`.
- Apenas arquivos Markdown são indexados.
- Symlinks são ignorados (arquivos ou diretórios).

### Embeddings Gemini (nativo)

Defina o provedor como `gemini` para usar a API de embeddings do Gemini diretamente:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-001",
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

Notas:

- `remote.baseUrl` é opcional (padrão é a URL base da API do Gemini).
- `remote.headers` permite adicionar headers extras, se necessário.
- Modelo padrão: `gemini-embedding-001`.

Se você quiser usar um **endpoint OpenAI-compatível personalizado** (OpenRouter, vLLM ou um proxy),
pode usar a configuração `remote` com o provedor OpenAI:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_OPENAI_COMPAT_API_KEY",
        headers: { "X-Custom-Header": "value" }
      }
    }
  }
}
```

Se você não quiser definir uma chave de API, use `memorySearch.provider = "local"` ou defina
`memorySearch.fallback = "none"`.

Fallbacks:

- `memorySearch.fallback` pode ser `openai`, `gemini`, `local` ou `none`.
- O provedor de fallback só é usado quando o provedor primário de embeddings falha.

Indexação em batch (OpenAI + Gemini):

- Ativada por padrão para embeddings OpenAI e Gemini. Defina `agents.defaults.memorySearch.remote.batch.enabled = false` para desativar.
- O comportamento padrão aguarda a conclusão do batch; ajuste `remote.batch.wait`, `remote.batch.pollIntervalMs` e `remote.batch.timeoutMinutes` se necessário.
- Defina `remote.batch.concurrency` para controlar quantos jobs de batch enviamos em paralelo (padrão: 2).
- O modo batch se aplica quando `memorySearch.provider = "openai"` ou `"gemini"` e usa a chave de API correspondente.
- Jobs de batch do Gemini usam o endpoint assíncrono de batch de embeddings e exigem disponibilidade da Gemini Batch API.

Por que o batch da OpenAI é rápido e barato:

- Para grandes backfills, a OpenAI geralmente é a opção mais rápida que suportamos porque podemos enviar muitas requisições de embedding em um único job de batch e deixar a OpenAI processá-las de forma assíncrona.
- A OpenAI oferece preços com desconto para workloads da Batch API, então grandes execuções de indexação costumam ser mais baratas do que enviar as mesmas requisições de forma síncrona.
- Veja a documentação e preços da OpenAI Batch API para detalhes:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

Exemplo de configuração:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "openai",
      remote: {
        batch: { enabled: true, concurrency: 2 }
      },
      sync: { watch: true }
    }
  }
}
```

Ferramentas:

- `memory_search` — retorna trechos com arquivo + intervalos de linha.
- `memory_get` — lê o conteúdo de um arquivo de memória pelo caminho.

Modo local:

- Defina `agents.defaults.memorySearch.provider = "local"`.
- Forneça `agents.defaults.memorySearch.local.modelPath` (GGUF ou URI `hf:`).
- Opcional: defina `agents.defaults.memorySearch.fallback = "none"` para evitar fallback remoto.

### Como as ferramentas de memória funcionam

- `memory_search` faz busca semântica em chunks Markdown (~alvo de 400 tokens, sobreposição de 80 tokens) de `MEMORY.md` + `memory/**/*.md`. Retorna texto do trecho (limitado a ~700 caracteres), caminho do arquivo, intervalo de linhas, score, provedor/modelo e se houve fallback de embeddings local → remoto. Nenhum payload de arquivo completo é retornado.
- `memory_get` lê um arquivo Markdown específico de memória (relativo ao workspace), opcionalmente a partir de uma linha inicial e por N linhas. Caminhos fora de `MEMORY.md` / `memory/` são rejeitados.
- Ambas as ferramentas só são habilitadas quando `memorySearch.enabled` resolve como true para o agente.

### O que é indexado (e quando)

- Tipo de arquivo: apenas Markdown (`MEMORY.md`, `memory/**/*.md`).
- Armazenamento do índice: SQLite por agente em `~/.openclaw/memory/<agentId>.sqlite` (configurável via `agents.defaults.memorySearch.store.path`, suporta token `{agentId}`).
- Atualidade: watcher em `MEMORY.md` + `memory/` marca o índice como sujo (debounce 1,5s). A sincronização é agendada no início da sessão, na busca ou em um intervalo e roda de forma assíncrona. Transcrições de sessão usam limiares de delta para disparar sync em segundo plano.
- Gatilhos de reindexação: o índice armazena **provedor/modelo de embedding + fingerprint do endpoint + parâmetros de chunking**. Se qualquer um mudar, o OpenClaw reseta e reindexa automaticamente todo o armazenamento.

### Busca híbrida (BM25 + vetor)

Quando ativada, o OpenClaw combina:

- **Similaridade vetorial** (correspondência semântica, a redação pode diferir)
- **Relevância por palavra-chave BM25** (tokens exatos como IDs, env vars, símbolos de código)

Se a busca full-text não estiver disponível na sua plataforma, o OpenClaw faz fallback para busca somente vetorial.

#### Por que híbrida?

Busca vetorial é ótima para “isso significa a mesma coisa”:

- “Mac Studio gateway host” vs “a máquina rodando o gateway”
- “debounce de atualizações de arquivo” vs “evitar indexar a cada gravação”

Mas pode ser fraca em tokens exatos e de alto sinal:

- IDs (`a828e60`, `b3b9895a…`)
- símbolos de código (`memorySearch.query.hybrid`)
- strings de erro (“sqlite-vec unavailable”)

BM25 (full-text) é o oposto: forte em tokens exatos, mais fraca em paráfrases.
A busca híbrida é o meio-termo pragmático: **usar ambos os sinais de recuperação** para obter
bons resultados tanto para consultas em “linguagem natural” quanto para consultas de “agulha no palheiro”.

#### Como mesclamos resultados (design atual)

Esboço de implementação:

1. Recuperar um pool de candidatos de ambos os lados:

- **Vetor**: top `maxResults * candidateMultiplier` por similaridade de cosseno.
- **BM25**: top `maxResults * candidateMultiplier` por rank BM25 do FTS5 (quanto menor, melhor).

2. Converter o rank BM25 em um score tipo 0..1:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. Unir candidatos por id de chunk e calcular um score ponderado:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

Notas:

- `vectorWeight` + `textWeight` é normalizado para 1,0 na resolução de config, então os pesos se comportam como percentuais.
- Se embeddings estiverem indisponíveis (ou o provedor retornar um vetor zero), ainda rodamos BM25 e retornamos correspondências por palavra-chave.
- Se o FTS5 não puder ser criado, mantemos busca somente vetorial (sem falha dura).

Isso não é “perfeito pela teoria de IR”, mas é simples, rápido e tende a melhorar recall/precisão em notas reais.
Se quisermos sofisticar depois, próximos passos comuns são Reciprocal Rank Fusion (RRF) ou normalização de score
(min/max ou z-score) antes de misturar.

Configuração:

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4
        }
      }
    }
  }
}
```

### Cache de embeddings

O OpenClaw pode armazenar em cache **embeddings de chunks** no SQLite para que reindexações e atualizações frequentes (especialmente transcrições de sessão) não re-embedem texto inalterado.

Configuração:

```json5
agents: {
  defaults: {
    memorySearch: {
      cache: {
        enabled: true,
        maxEntries: 50000
      }
    }
  }
}
```

### Busca de memória de sessão (experimental)

Você pode opcionalmente indexar **transcrições de sessão** e expô-las via `memory_search`.
Isso fica atrás de uma flag experimental.

```json5
agents: {
  defaults: {
    memorySearch: {
      experimental: { sessionMemory: true },
      sources: ["memory", "sessions"]
    }
  }
}
```

Notas:

- A indexação de sessão é **opt-in** (desligada por padrão).
- Atualizações de sessão têm debounce e são **indexadas de forma assíncrona** quando cruzam limiares de delta (best-effort).
- `memory_search` nunca bloqueia aguardando indexação; os resultados podem ficar levemente desatualizados até a sincronização em segundo plano terminar.
- Os resultados ainda incluem apenas trechos; `memory_get` permanece limitado a arquivos de memória.
- A indexação de sessão é isolada por agente (somente os logs de sessão daquele agente são indexados).
- Logs de sessão ficam em disco (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`). Qualquer processo/usuário com acesso ao filesystem pode lê-los, então trate o acesso ao disco como o limite de confiança. Para isolamento mais rigoroso, execute agentes sob usuários de SO separados ou hosts distintos.

Limiares de delta (padrões mostrados):

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // ~100 KB
          deltaMessages: 50     // JSONL lines
        }
      }
    }
  }
}
```

### Aceleração vetorial SQLite (sqlite-vec)

Quando a extensão sqlite-vec está disponível, o OpenClaw armazena embeddings em uma
tabela virtual SQLite (`vec0`) e executa consultas de distância vetorial no
banco de dados. Isso mantém a busca rápida sem carregar todos os embeddings em JS.

Configuração (opcional):

```json5
agents: {
  defaults: {
    memorySearch: {
      store: {
        vector: {
          enabled: true,
          extensionPath: "/path/to/sqlite-vec"
        }
      }
    }
  }
}
```

Notas:

- `enabled` é true por padrão; quando desativado, a busca faz fallback para
  similaridade de cosseno em processo sobre embeddings armazenados.
- Se a extensão sqlite-vec estiver ausente ou falhar ao carregar, o OpenClaw registra o
  erro e continua com o fallback em JS (sem tabela vetorial).
- `extensionPath` sobrescreve o caminho do sqlite-vec empacotado (útil para builds
  personalizados ou locais de instalação não padrão).

### Download automático de embeddings locais

- Modelo padrão de embedding local: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0,6 GB).
- Quando `memorySearch.provider = "local"`, `node-llama-cpp` resolve `modelPath`; se o GGUF estiver ausente, ele **faz download automático** para o cache (ou `local.modelCacheDir` se definido) e então carrega. Downloads retomam na tentativa seguinte.
- Requisito de build nativo: execute `pnpm approve-builds`, escolha `node-llama-cpp`, depois `pnpm rebuild node-llama-cpp`.
- Fallback: se a configuração local falhar e `memorySearch.fallback = "openai"`, alternamos automaticamente para embeddings remotos (`openai/text-embedding-3-small` salvo sobrescrita) e registramos o motivo.

### Exemplo de endpoint OpenAI-compatível personalizado

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_REMOTE_API_KEY",
        headers: {
          "X-Organization": "org-id",
          "X-Project": "project-id"
        }
      }
    }
  }
}
```

Notas:

- `remote.*` tem precedência sobre `models.providers.openai.*`.
- `remote.headers` se mescla com os headers da OpenAI; o remoto vence em conflitos de chave. Omita `remote.headers` para usar os padrões da OpenAI.
