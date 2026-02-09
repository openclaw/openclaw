---
summary: "Use modelos focados em privacidade da Venice AI no OpenClaw"
read_when:
  - Você quer inferência focada em privacidade no OpenClaw
  - Você quer orientações de configuração da Venice AI
title: "Venice AI"
---

# Venice AI (destaque Venice)

**Venice** é nossa configuração em destaque da Venice para inferência com foco em privacidade, com acesso anonimizado opcional a modelos proprietários.

A Venice AI fornece inferência de IA focada em privacidade, com suporte a modelos sem censura e acesso aos principais modelos proprietários por meio do proxy anonimizado. Toda a inferência é privada por padrão — sem treinamento com seus dados, sem registros.

## Por que Venice no OpenClaw

- **Inferência privada** para modelos open-source (sem registros).
- **Modelos sem censura** quando você precisa.
- **Acesso anonimizado** a modelos proprietários (Opus/GPT/Gemini) quando a qualidade importa.
- Endpoints `/v1` compatíveis com OpenAI.

## Modos de Privacidade

A Venice oferece dois níveis de privacidade — entender isso é fundamental para escolher seu modelo:

| Modo            | Descrição                                                                                                                                                               | Modelos                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Privado**     | Totalmente privado. Prompts/respostas **nunca são armazenados ou registrados**. Efêmero.                                | Llama, Qwen, DeepSeek, Venice Uncensored etc. |
| **Anonimizado** | Encaminhado pela Venice com metadados removidos. O provedor subjacente (OpenAI, Anthropic) vê solicitações anônimas. | Claude, GPT, Gemini, Grok, Kimi, MiniMax                      |

## Funcionalidades

- **Foco em privacidade**: Escolha entre os modos "privado" (totalmente privado) e "anonimizado" (com proxy)
- **Modelos sem censura**: Acesso a modelos sem restrições de conteúdo
- **Acesso a modelos principais**: Use Claude, GPT-5.2, Gemini, Grok via proxy anonimizado da Venice
- **API compatível com OpenAI**: Endpoints padrão `/v1` para integração fácil
- **Streaming**: ✅ Compatível em todos os modelos
- **Chamada de funções**: ✅ Compatível em modelos selecionados (verifique as capacidades do modelo)
- **Visão**: ✅ Compatível em modelos com capacidade de visão
- **Sem limites rígidos de taxa**: Pode haver limitação por uso justo em casos de uso extremo

## Configuração

### 1. Obtenha a chave de API

1. Cadastre-se em [venice.ai](https://venice.ai)
2. Vá em **Settings → API Keys → Create new key**
3. Copie sua chave de API (formato: `vapi_xxxxxxxxxxxx`)

### 2) Configure o OpenClaw

**Opção A: Variável de ambiente**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**Opção B: Configuração interativa (Recomendado)**

```bash
openclaw onboard --auth-choice venice-api-key
```

Isso irá:

1. Solicitar sua chave de API (ou usar a existente `VENICE_API_KEY`)
2. Mostrar todos os modelos Venice disponíveis
3. Permitir escolher seu modelo padrão
4. Configurar o provedor automaticamente

**Opção C: Não interativa**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. Verifique a configuração

```bash
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## Seleção de Modelo

Após a configuração, o OpenClaw mostra todos os modelos Venice disponíveis. Escolha conforme suas necessidades:

- **Padrão (nossa escolha)**: `venice/llama-3.3-70b` para desempenho equilibrado e privado.
- **Melhor qualidade geral**: `venice/claude-opus-45` para tarefas difíceis (Opus continua sendo o mais forte).
- **Privacidade**: Escolha modelos "privados" para inferência totalmente privada.
- **Capacidade**: Escolha modelos "anonimizados" para acessar Claude, GPT, Gemini via proxy da Venice.

Altere seu modelo padrão a qualquer momento:

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

Liste todos os modelos disponíveis:

```bash
openclaw models list | grep venice
```

## Configurar via `openclaw configure`

1. Execute `openclaw configure`
2. Selecione **Model/auth**
3. Escolha **Venice AI**

## Qual Modelo Devo Usar?

| Caso de uso                        | Modelo recomendado               | Por quê                                 |
| ---------------------------------- | -------------------------------- | --------------------------------------- |
| **Chat geral**                     | `llama-3.3-70b`                  | Bom em geral, totalmente privado        |
| **Melhor qualidade geral**         | `claude-opus-45`                 | Opus continua sendo o mais forte        |
| **Privacidade + qualidade Claude** | `claude-opus-45`                 | Melhor raciocínio via proxy anonimizado |
| **Programação**                    | `qwen3-coder-480b-a35b-instruct` | Otimizado para código, contexto de 262k |
| **Tarefas de visão**               | `qwen3-vl-235b-a22b`             | Melhor modelo privado para visão        |
| **Sem censura**                    | `venice-uncensored`              | Sem restrições de conteúdo              |
| **Rápido + barato**                | `qwen3-4b`                       | Leve, ainda capaz                       |
| **Raciocínio complexo**            | `deepseek-v3.2`                  | Raciocínio forte, privado               |

## Modelos Disponíveis (25 no total)

### Modelos Privados (15) — Totalmente Privados, Sem Registros

| ID do modelo                     | Nome                                       | Contexto (tokens) | Funcionalidades         |
| -------------------------------- | ------------------------------------------ | ------------------------------------ | ----------------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B              | 131k                                 | Geral                   |
| `llama-3.2-3b`                   | Llama 3.2 3B               | 131k                                 | Rápido, leve            |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B    | 131k                                 | Tarefas complexas       |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking                        | 131k                                 | Raciocínio              |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct                        | 131k                                 | Geral                   |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B                           | 262k                                 | Código                  |
| `qwen3-next-80b`                 | Qwen3 Next 80B                             | 262k                                 | Geral                   |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B                              | 262k                                 | Visão                   |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k                                  | Rápido, raciocínio      |
| `deepseek-v3.2`                  | DeepSeek V3.2              | 163k                                 | Raciocínio              |
| `venice-uncensored`              | Venice Uncensored                          | 32k                                  | Sem censura             |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k                                 | Visão                   |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct                       | 202k                                 | Visão                   |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B                        | 131k                                 | Geral                   |
| `zai-org-glm-4.7`                | GLM 4.7                    | 202k                                 | Raciocínio, multilíngue |

### Modelos Anonimizados (10) — Via Proxy da Venice

| ID do modelo             | Original                          | Contexto (tokens) | Funcionalidades    |
| ------------------------ | --------------------------------- | ------------------------------------ | ------------------ |
| `claude-opus-45`         | Claude Opus 4.5   | 202k                                 | Raciocínio, visão  |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k                                 | Raciocínio, visão  |
| `openai-gpt-52`          | GPT-5.2           | 262k                                 | Raciocínio         |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k                                 | Raciocínio, visão  |
| `gemini-3-pro-preview`   | Gemini 3 Pro                      | 202k                                 | Raciocínio, visão  |
| `gemini-3-flash-preview` | Gemini 3 Flash                    | 262k                                 | Raciocínio, visão  |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k                                 | Raciocínio, visão  |
| `grok-code-fast-1`       | Grok Code Fast 1                  | 262k                                 | Raciocínio, código |
| `kimi-k2-thinking`       | Kimi K2 Thinking                  | 262k                                 | Raciocínio         |
| `minimax-m21`            | MiniMax M2.1      | 202k                                 | Raciocínio         |

## Descoberta de Modelos

O OpenClaw descobre automaticamente modelos a partir da API da Venice quando `VENICE_API_KEY` está definido. Se a API estiver inacessível, ele recorre a um catálogo estático.

O endpoint `/models` é público (sem autenticação necessária para listar), mas a inferência requer uma chave de API válida.

## Streaming e Suporte a Ferramentas

| Funcionalidade         | Suporte                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------- |
| **Streaming**          | ✅ Todos os modelos                                                                      |
| **Chamada de funções** | ✅ A maioria dos modelos (verifique `supportsFunctionCalling` na API) |
| **Visão/Imagens**      | ✅ Modelos marcados com o recurso "Vision"                                               |
| **Modo JSON**          | ✅ Compatível via `response_format`                                                      |

## Preços

A Venice usa um sistema baseado em créditos. Consulte [venice.ai/pricing](https://venice.ai/pricing) para as tarifas atuais:

- **Modelos privados**: Geralmente menor custo
- **Modelos anonimizados**: Semelhantes ao preço da API direta + pequena taxa da Venice

## Comparação: Venice vs API Direta

| Aspecto         | Venice (Anonimizado) | API Direta           |
| --------------- | --------------------------------------- | -------------------- |
| **Privacidade** | Metadados removidos, anonimizado        | Sua conta vinculada  |
| **Latência**    | +10–50ms (proxy)     | Direta               |
| **Recursos**    | A maioria dos recursos compatível       | Recursos completos   |
| **Cobrança**    | Créditos Venice                         | Cobrança do provedor |

## Exemplos de Uso

```bash
# Use default private model
openclaw chat --model venice/llama-3.3-70b

# Use Claude via Venice (anonymized)
openclaw chat --model venice/claude-opus-45

# Use uncensored model
openclaw chat --model venice/venice-uncensored

# Use vision model with image
openclaw chat --model venice/qwen3-vl-235b-a22b

# Use coding model
openclaw chat --model venice/qwen3-coder-480b-a35b-instruct
```

## Solução de problemas

### Chave de API não reconhecida

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

Certifique-se de que a chave começa com `vapi_`.

### Modelo não disponível

O catálogo de modelos da Venice é atualizado dinamicamente. Execute `openclaw models list` para ver os modelos disponíveis no momento. Alguns modelos podem estar temporariamente offline.

### Problemas de conexão

A API da Venice está em `https://api.venice.ai/api/v1`. Garanta que sua rede permita conexões HTTPS.

## Exemplo de arquivo de configuração

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: { defaults: { model: { primary: "venice/llama-3.3-70b" } } },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Links

- [Venice AI](https://venice.ai)
- [Documentação da API](https://docs.venice.ai)
- [Preços](https://venice.ai/pricing)
- [Status](https://status.venice.ai)
