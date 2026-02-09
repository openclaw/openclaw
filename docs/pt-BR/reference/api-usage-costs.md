---
summary: "Audite o que pode gastar dinheiro, quais chaves são usadas e como visualizar o uso"
read_when:
  - Você quer entender quais recursos podem chamar APIs pagas
  - Você precisa auditar chaves, custos e visibilidade de uso
  - Você está explicando relatórios de custo via /status ou /usage
title: "Uso e custos de API"
---

# Uso e custos de API

Este documento lista **recursos que podem invocar chaves de API** e onde seus custos aparecem. Ele se concentra em
recursos do OpenClaw que podem gerar uso de provedores ou chamadas de API pagas.

## Onde os custos aparecem (chat + CLI)

**Instantâneo de custo por sessão**

- `/status` mostra o modelo da sessão atual, o uso de contexto e os tokens da última resposta.
- Se o modelo usar **autenticação por chave de API**, `/status` também mostra o **custo estimado** da última resposta.

**Rodapé de custo por mensagem**

- `/usage full` adiciona um rodapé de uso a cada resposta, incluindo **custo estimado** (somente com chave de API).
- `/usage tokens` mostra apenas tokens; fluxos OAuth ocultam o custo em dólares.

**Janelas de uso na CLI (cotas do provedor)**

- `openclaw status --usage` e `openclaw channels list` mostram **janelas de uso** do provedor
  (instantâneos de cota, não custos por mensagem).

Veja [Uso de tokens e custos](/reference/token-use) para detalhes e exemplos.

## Como as chaves são descobertas

O OpenClaw pode obter credenciais de:

- **Perfis de autenticação** (por agente, armazenados em `auth-profiles.json`).
- **Variáveis de ambiente** (por exemplo, `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **Configuração** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`).
- **Skills** (`skills.entries.<name>.apiKey`) que podem exportar chaves para o ambiente de processo da skill.

## Recursos que podem gastar chaves

### 1. Respostas do modelo principal (chat + ferramentas)

Cada resposta ou chamada de ferramenta usa o **provedor do modelo atual** (OpenAI, Anthropic etc.). Esta é a
principal fonte de uso e custo.

Veja [Modelos](/providers/models) para configuração de preços e [Uso de tokens e custos](/reference/token-use) para exibição.

### 2. Compreensão de mídia (áudio/imagem/vídeo)

Mídias de entrada podem ser resumidas/transcritas antes da resposta ser executada. Isso usa APIs de modelos/provedores.

- Áudio: OpenAI / Groq / Deepgram (agora **habilitado automaticamente** quando existem chaves).
- Imagem: OpenAI / Anthropic / Google.
- Vídeo: Google.

Veja [Compreensão de mídia](/nodes/media-understanding).

### 3. Embeddings de memória + busca semântica

A busca semântica de memória usa **APIs de embeddings** quando configurada para provedores remotos:

- `memorySearch.provider = "openai"` → embeddings do OpenAI
- `memorySearch.provider = "gemini"` → embeddings do Gemini
- `memorySearch.provider = "voyage"` → embeddings do Voyage
- Fallback opcional para um provedor remoto se embeddings locais falharem

Você pode manter tudo local com `memorySearch.provider = "local"` (sem uso de API).

Veja [Memória](/concepts/memory).

### 4. Ferramenta de busca na web (Brave / Perplexity via OpenRouter)

`web_search` usa chaves de API e pode incorrer em cobranças de uso:

- **Brave Search API**: `BRAVE_API_KEY` ou `tools.web.search.apiKey`
- **Perplexity** (via OpenRouter): `PERPLEXITY_API_KEY` ou `OPENROUTER_API_KEY`

**Camada gratuita do Brave (generosa):**

- **2.000 solicitações/mês**
- **1 solicitação/segundo**
- **Cartão de crédito obrigatório** para verificação (sem cobrança a menos que você faça upgrade)

Veja [Ferramentas web](/tools/web).

### 5. Ferramenta de coleta web (Firecrawl)

`web_fetch` pode chamar o **Firecrawl** quando uma chave de API está presente:

- `FIRECRAWL_API_KEY` ou `tools.web.fetch.firecrawl.apiKey`

Se o Firecrawl não estiver configurado, a ferramenta recorre a coleta direta + legibilidade (sem API paga).

Veja [Ferramentas web](/tools/web).

### 6. Instantâneos de uso do provedor (status/saúde)

Alguns comandos de status chamam **endpoints de uso do provedor** para exibir janelas de cota ou saúde de autenticação.
Normalmente são chamadas de baixo volume, mas ainda atingem APIs do provedor:

- `openclaw status --usage`
- `openclaw models status --json`

Veja [Models CLI](/cli/models).

### 7. Resumo de salvaguarda de compactação

A salvaguarda de compactação pode resumir o histórico da sessão usando o **modelo atual**, o que
invoca APIs do provedor quando é executada.

Veja [Gerenciamento de sessão + compactação](/reference/session-management-compaction).

### 8. Varredura / sondagem de modelos

`openclaw models scan` pode sondar modelos do OpenRouter e usa `OPENROUTER_API_KEY` quando
a sondagem está habilitada.

Veja [Models CLI](/cli/models).

### 9. Talk (fala)

O modo Talk pode invocar o **ElevenLabs** quando configurado:

- `ELEVENLABS_API_KEY` ou `talk.apiKey`

Veja [Modo Talk](/nodes/talk).

### 10. Skills (APIs de terceiros)

Skills podem armazenar `apiKey` em `skills.entries.<name>.apiKey`. Se uma skill usar essa chave para
APIs externas, ela pode incorrer em custos de acordo com o provedor da skill.

Veja [Skills](/tools/skills).
