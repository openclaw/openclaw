# DSPy.rb LLM Providers

## Adapter Architecture

DSPy.rb ships provider SDKs as separate adapter gems. Install only the adapters the project needs. Each adapter gem depends on the official SDK for its provider and auto-loads when present -- no explicit `require` necessary.

```ruby
# Gemfile
gem 'dspy'              # core framework (no provider SDKs)
gem 'dspy-openai'       # OpenAI, OpenRouter, Ollama
gem 'dspy-anthropic'    # Claude
gem 'dspy-gemini'       # Gemini
gem 'dspy-ruby_llm'     # RubyLLM unified adapter (12+ providers)
```

---

## Per-Provider Adapters

### dspy-openai

Covers any endpoint that speaks the OpenAI chat-completions protocol: OpenAI itself, OpenRouter, and Ollama.

**SDK dependency:** `openai ~> 0.17`

```ruby
# OpenAI
lm = DSPy::LM.new('openai/gpt-4o-mini', api_key: ENV['OPENAI_API_KEY'])

# OpenRouter -- access 200+ models behind a single key
lm = DSPy::LM.new('openrouter/x-ai/grok-4-fast:free',
  api_key: ENV['OPENROUTER_API_KEY']
)

# Ollama -- local models, no API key required
lm = DSPy::LM.new('ollama/llama3.2')

# Remote Ollama instance
lm = DSPy::LM.new('ollama/llama3.2',
  base_url: 'https://my-ollama.example.com/v1',
  api_key: 'optional-auth-token'
)
```

All three sub-adapters share the same request handling, structured-output support, and error reporting. Swap providers without changing higher-level DSPy code.

For OpenRouter models that lack native structured-output support, disable it explicitly:

```ruby
lm = DSPy::LM.new('openrouter/deepseek/deepseek-chat-v3.1:free',
  api_key: ENV['OPENROUTER_API_KEY'],
  structured_outputs: false
)
```

### dspy-anthropic

Provides the Claude adapter. Install it for any `anthropic/*` model id.

**SDK dependency:** `anthropic ~> 1.12`

```ruby
lm = DSPy::LM.new('anthropic/claude-sonnet-4-20250514',
  api_key: ENV['ANTHROPIC_API_KEY']
)
```

Structured outputs default to tool-based JSON extraction (`structured_outputs: true`). Set `structured_outputs: false` to use enhanced-prompting extraction instead.

```ruby
# Tool-based extraction (default, most reliable)
lm = DSPy::LM.new('anthropic/claude-sonnet-4-20250514',
  api_key: ENV['ANTHROPIC_API_KEY'],
  structured_outputs: true
)

# Enhanced prompting extraction
lm = DSPy::LM.new('anthropic/claude-sonnet-4-20250514',
  api_key: ENV['ANTHROPIC_API_KEY'],
  structured_outputs: false
)
```

### dspy-gemini

Provides the Gemini adapter. Install it for any `gemini/*` model id.

**SDK dependency:** `gemini-ai ~> 4.3`

```ruby
lm = DSPy::LM.new('gemini/gemini-2.5-flash',
  api_key: ENV['GEMINI_API_KEY']
)
```

**Environment variable:** `GEMINI_API_KEY` (also accepts `GOOGLE_API_KEY`).

---

## RubyLLM Unified Adapter

The `dspy-ruby_llm` gem provides a single adapter that routes to 12+ providers through [RubyLLM](https://rubyllm.com). Use it when a project talks to multiple providers or needs access to Bedrock, VertexAI, DeepSeek, or Mistral without dedicated adapter gems.

**SDK dependency:** `ruby_llm ~> 1.3`

### Model ID Format

Prefix every model id with `ruby_llm/`:

```ruby
lm = DSPy::LM.new('ruby_llm/gpt-4o-mini')
lm = DSPy::LM.new('ruby_llm/claude-sonnet-4-20250514')
lm = DSPy::LM.new('ruby_llm/gemini-2.5-flash')
```

The adapter detects the provider from RubyLLM's model registry automatically. For models not in the registry, pass `provider:` explicitly:

```ruby
lm = DSPy::LM.new('ruby_llm/llama3.2', provider: 'ollama')
lm = DSPy::LM.new('ruby_llm/anthropic/claude-3-opus',
  api_key: ENV['OPENROUTER_API_KEY'],
  provider: 'openrouter'
)
```

### Using Existing RubyLLM Configuration

When RubyLLM is already configured globally, omit the `api_key:` argument. DSPy reuses the global config automatically:

```ruby
RubyLLM.configure do |config|
  config.openai_api_key = ENV['OPENAI_API_KEY']
  config.anthropic_api_key = ENV['ANTHROPIC_API_KEY']
end

# No api_key needed -- picks up the global config
DSPy.configure do |c|
  c.lm = DSPy::LM.new('ruby_llm/gpt-4o-mini')
end
```

When an `api_key:` (or any of `base_url:`, `timeout:`, `max_retries:`) is passed, DSPy creates a **scoped context** instead of reusing the global config.

### Cloud-Hosted Providers (Bedrock, VertexAI)

Configure RubyLLM globally first, then reference the model:

```ruby
# AWS Bedrock
RubyLLM.configure do |c|
  c.bedrock_api_key = ENV['AWS_ACCESS_KEY_ID']
  c.bedrock_secret_key = ENV['AWS_SECRET_ACCESS_KEY']
  c.bedrock_region = 'us-east-1'
end
lm = DSPy::LM.new('ruby_llm/anthropic.claude-3-5-sonnet', provider: 'bedrock')

# Google VertexAI
RubyLLM.configure do |c|
  c.vertexai_project_id = 'your-project-id'
  c.vertexai_location = 'us-central1'
end
lm = DSPy::LM.new('ruby_llm/gemini-pro', provider: 'vertexai')
```

### Supported Providers Table

| Provider    | Example Model ID                           | Notes                           |
|-------------|--------------------------------------------|---------------------------------|
| OpenAI      | `ruby_llm/gpt-4o-mini`                    | Auto-detected from registry     |
| Anthropic   | `ruby_llm/claude-sonnet-4-20250514`       | Auto-detected from registry     |
| Gemini      | `ruby_llm/gemini-2.5-flash`               | Auto-detected from registry     |
| DeepSeek    | `ruby_llm/deepseek-chat`                  | Auto-detected from registry     |
| Mistral     | `ruby_llm/mistral-large`                  | Auto-detected from registry     |
| Ollama      | `ruby_llm/llama3.2`                       | Use `provider: 'ollama'`        |
| AWS Bedrock | `ruby_llm/anthropic.claude-3-5-sonnet`    | Configure RubyLLM globally      |
| VertexAI    | `ruby_llm/gemini-pro`                     | Configure RubyLLM globally      |
| OpenRouter  | `ruby_llm/anthropic/claude-3-opus`        | Use `provider: 'openrouter'`    |
| Perplexity  | `ruby_llm/llama-3.1-sonar-large`          | Use `provider: 'perplexity'`    |
| GPUStack    | `ruby_llm/model-name`                     | Use `provider: 'gpustack'`      |

---

## Rails Initializer Pattern

Configure DSPy inside an `after_initialize` block so Rails credentials and environment are fully loaded:

```ruby
# config/initializers/dspy.rb
Rails.application.config.after_initialize do
  return if Rails.env.test? # skip in test -- use VCR cassettes instead

  DSPy.configure do |config|
    config.lm = DSPy::LM.new(
      'openai/gpt-4o-mini',
      api_key: Rails.application.credentials.openai_api_key,
      structured_outputs: true
    )

    config.logger = if Rails.env.production?
      Dry.Logger(:dspy, formatter: :json) do |logger|
        logger.add_backend(stream: Rails.root.join("log/dspy.log"))
      end
    else
      Dry.Logger(:dspy) do |logger|
        logger.add_backend(level: :debug, stream: $stdout)
      end
    end
  end
end
```

Key points:

- Wrap in `after_initialize` so `Rails.application.credentials` is available.
- Return early in the test environment. Rely on VCR cassettes for deterministic LLM responses.
- Set `structured_outputs: true` (the default) for provider-native JSON extraction.
- Use `Dry.Logger` with `:json` formatter in production for structured log parsing.

---

## Fiber-Local LM Context

`DSPy.with_lm` sets a temporary language-model override scoped to the current Fiber. Every predictor call inside the block uses the override; outside the block the previous LM takes effect again.

```ruby
fast = DSPy::LM.new('openai/gpt-4o-mini', api_key: ENV['OPENAI_API_KEY'])
powerful = DSPy::LM.new('anthropic/claude-sonnet-4-20250514', api_key: ENV['ANTHROPIC_API_KEY'])

classifier = Classifier.new

# Uses the global LM
result = classifier.call(text: "Hello")

# Temporarily switch to the fast model
DSPy.with_lm(fast) do
  result = classifier.call(text: "Hello")   # uses gpt-4o-mini
end

# Temporarily switch to the powerful model
DSPy.with_lm(powerful) do
  result = classifier.call(text: "Hello")   # uses claude-sonnet-4
end
```

### LM Resolution Hierarchy

DSPy resolves the active language model in this order:

1. **Instance-level LM** -- set directly on a module instance via `configure`
2. **Fiber-local LM** -- set via `DSPy.with_lm`
3. **Global LM** -- set via `DSPy.configure`

Instance-level configuration always wins, even inside a `DSPy.with_lm` block:

```ruby
classifier = Classifier.new
classifier.configure { |c| c.lm = DSPy::LM.new('anthropic/claude-sonnet-4-20250514', api_key: ENV['ANTHROPIC_API_KEY']) }

fast = DSPy::LM.new('openai/gpt-4o-mini', api_key: ENV['OPENAI_API_KEY'])

DSPy.with_lm(fast) do
  classifier.call(text: "Test")  # still uses claude-sonnet-4 (instance-level wins)
end
```

### configure_predictor for Fine-Grained Agent Control

Complex agents (`ReAct`, `CodeAct`, `DeepResearch`, `DeepSearch`) contain internal predictors. Use `configure` for a blanket override and `configure_predictor` to target a specific sub-predictor:

```ruby
agent = DSPy::ReAct.new(MySignature, tools: tools)

# Set a default LM for the agent and all its children
agent.configure { |c| c.lm = DSPy::LM.new('openai/gpt-4o-mini', api_key: ENV['OPENAI_API_KEY']) }

# Override just the reasoning predictor with a more capable model
agent.configure_predictor('thought_generator') do |c|
  c.lm = DSPy::LM.new('anthropic/claude-sonnet-4-20250514', api_key: ENV['ANTHROPIC_API_KEY'])
end

result = agent.call(question: "Summarize the report")
```

Both methods support chaining:

```ruby
agent
  .configure { |c| c.lm = cheap_model }
  .configure_predictor('thought_generator') { |c| c.lm = expensive_model }
```

#### Available Predictors by Agent Type

| Agent                | Internal Predictors                                              |
|----------------------|------------------------------------------------------------------|
| `DSPy::ReAct`        | `thought_generator`, `observation_processor`                    |
| `DSPy::CodeAct`      | `code_generator`, `observation_processor`                       |
| `DSPy::DeepResearch`  | `planner`, `synthesizer`, `qa_reviewer`, `reporter`            |
| `DSPy::DeepSearch`    | `seed_predictor`, `search_predictor`, `reader_predictor`, `reason_predictor` |

#### Propagation Rules

- Configuration propagates recursively to children and grandchildren.
- Children with an already-configured LM are **not** overwritten by a later parent `configure` call.
- Configure the parent first, then override specific children.

---

## Feature-Flagged Model Selection

Use a `FeatureFlags` module backed by ENV vars to centralize model selection. Each tool or agent reads its model from the flags, falling back to a global default.

```ruby
module FeatureFlags
  module_function

  def default_model
    ENV.fetch('DSPY_DEFAULT_MODEL', 'openai/gpt-4o-mini')
  end

  def default_api_key
    ENV.fetch('DSPY_DEFAULT_API_KEY') { ENV.fetch('OPENAI_API_KEY', nil) }
  end

  def model_for(tool_name)
    env_key = "DSPY_MODEL_#{tool_name.upcase}"
    ENV.fetch(env_key, default_model)
  end

  def api_key_for(tool_name)
    env_key = "DSPY_API_KEY_#{tool_name.upcase}"
    ENV.fetch(env_key, default_api_key)
  end
end
```

### Per-Tool Model Override

Override an individual tool's model without touching application code:

```bash
# .env
DSPY_DEFAULT_MODEL=openai/gpt-4o-mini
DSPY_DEFAULT_API_KEY=sk-...

# Override the classifier to use Claude
DSPY_MODEL_CLASSIFIER=anthropic/claude-sonnet-4-20250514
DSPY_API_KEY_CLASSIFIER=sk-ant-...

# Override the summarizer to use Gemini
DSPY_MODEL_SUMMARIZER=gemini/gemini-2.5-flash
DSPY_API_KEY_SUMMARIZER=...
```

Wire each agent to its flag at initialization:

```ruby
class ClassifierAgent < DSPy::Module
  def initialize
    super
    model = FeatureFlags.model_for('classifier')
    api_key = FeatureFlags.api_key_for('classifier')

    @predictor = DSPy::Predict.new(ClassifySignature)
    configure { |c| c.lm = DSPy::LM.new(model, api_key: api_key) }
  end

  def forward(text:)
    @predictor.call(text: text)
  end
end
```

This pattern keeps model routing declarative and avoids scattering `DSPy::LM.new` calls across the codebase.

---

## Compatibility Matrix

Feature support across direct adapter gems. All features listed assume `structured_outputs: true` (the default).

| Feature              | OpenAI | Anthropic | Gemini | Ollama   | OpenRouter | RubyLLM     |
|----------------------|--------|-----------|--------|----------|------------|-------------|
| Structured Output    | Native JSON mode | Tool-based extraction | Native JSON schema | OpenAI-compatible JSON | Varies by model | Via `with_schema` |
| Vision (Images)      | File + URL | File + Base64 | File + Base64 | Limited  | Varies     | Delegates to underlying provider |
| Image URLs           | Yes    | No        | No     | No       | Varies     | Depends on provider |
| Tool Calling         | Yes    | Yes       | Yes    | Varies   | Varies     | Yes         |
| Streaming            | Yes    | Yes       | Yes    | Yes      | Yes        | Yes         |

**Notes:**

- **Structured Output** is enabled by default on every adapter. Set `structured_outputs: false` to fall back to enhanced-prompting extraction.
- **Vision / Image URLs:** Only OpenAI supports passing a URL directly. For Anthropic and Gemini, load images from file or Base64:
  ```ruby
  DSPy::Image.from_url("https://example.com/img.jpg")    # OpenAI only
  DSPy::Image.from_file("path/to/image.jpg")             # all providers
  DSPy::Image.from_base64(data, mime_type: "image/jpeg")  # all providers
  ```
- **RubyLLM** delegates to the underlying provider, so feature support matches the provider column in the table.

### Choosing an Adapter Strategy

| Scenario                                  | Recommended Adapter            |
|-------------------------------------------|--------------------------------|
| Single provider (OpenAI, Claude, or Gemini) | Dedicated gem (`dspy-openai`, `dspy-anthropic`, `dspy-gemini`) |
| Multi-provider with per-agent model routing | `dspy-ruby_llm`               |
| AWS Bedrock or Google VertexAI             | `dspy-ruby_llm`               |
| Local development with Ollama              | `dspy-openai` (Ollama sub-adapter) or `dspy-ruby_llm` |
| OpenRouter for cost optimization           | `dspy-openai` (OpenRouter sub-adapter) |

### Current Recommended Models

| Provider  | Model ID                              | Use Case              |
|-----------|---------------------------------------|-----------------------|
| OpenAI    | `openai/gpt-4o-mini`                 | Fast, cost-effective  |
| Anthropic | `anthropic/claude-sonnet-4-20250514` | Balanced reasoning    |
| Gemini    | `gemini/gemini-2.5-flash`            | Fast, cost-effective  |
| Ollama    | `ollama/llama3.2`                    | Local, zero API cost  |
