# DSPy.rb Observability

DSPy.rb provides an event-driven observability system built on OpenTelemetry. The system replaces monkey-patching with structured event emission, pluggable listeners, automatic span creation, and non-blocking Langfuse export.

## Event System

### Emitting Events

Emit structured events with `DSPy.event`:

```ruby
DSPy.event('lm.tokens', {
  'gen_ai.system' => 'openai',
  'gen_ai.request.model' => 'gpt-4',
  input_tokens: 150,
  output_tokens: 50,
  total_tokens: 200
})
```

Event names are **strings** with dot-separated namespaces (e.g., `'llm.generate'`, `'react.iteration_complete'`, `'chain_of_thought.reasoning_complete'`). Do not use symbols for event names.

Attributes must be JSON-serializable. DSPy automatically merges context (trace ID, module stack) and creates OpenTelemetry spans.

### Global Subscriptions

Subscribe to events across the entire application with `DSPy.events.subscribe`:

```ruby
# Exact event name
subscription_id = DSPy.events.subscribe('lm.tokens') do |event_name, attrs|
  puts "Tokens used: #{attrs[:total_tokens]}"
end

# Wildcard pattern -- matches llm.generate, llm.stream, etc.
DSPy.events.subscribe('llm.*') do |event_name, attrs|
  track_llm_usage(attrs)
end

# Catch-all wildcard
DSPy.events.subscribe('*') do |event_name, attrs|
  log_everything(event_name, attrs)
end
```

Use global subscriptions for cross-cutting concerns: observability exporters (Langfuse, Datadog), centralized logging, metrics collection.

### Module-Scoped Subscriptions

Declare listeners inside a `DSPy::Module` subclass. Subscriptions automatically scope to the module instance and its descendants:

```ruby
class ResearchReport < DSPy::Module
  subscribe 'lm.tokens', :track_tokens, scope: :descendants

  def initialize
    super
    @outliner = DSPy::Predict.new(OutlineSignature)
    @writer   = DSPy::Predict.new(SectionWriterSignature)
    @token_count = 0
  end

  def forward(question:)
    outline = @outliner.call(question: question)
    outline.sections.map do |title|
      draft = @writer.call(question: question, section_title: title)
      { title: title, body: draft.paragraph }
    end
  end

  def track_tokens(_event, attrs)
    @token_count += attrs.fetch(:total_tokens, 0)
  end
end
```

The `scope:` parameter accepts:
- `:descendants` (default) -- receives events from the module **and** every nested module invoked inside it.
- `DSPy::Module::SubcriptionScope::SelfOnly` -- restricts delivery to events emitted by the module instance itself; ignores descendants.

Inspect active subscriptions with `registered_module_subscriptions`. Tear down with `unsubscribe_module_events`.

### Unsubscribe and Cleanup

Remove a global listener by subscription ID:

```ruby
id = DSPy.events.subscribe('llm.*') { |name, attrs| }
DSPy.events.unsubscribe(id)
```

Build tracker classes that manage their own subscription lifecycle:

```ruby
class TokenBudgetTracker
  def initialize(budget:)
    @budget = budget
    @usage  = 0
    @subscriptions = []
    @subscriptions << DSPy.events.subscribe('lm.tokens') do |_event, attrs|
      @usage += attrs.fetch(:total_tokens, 0)
      warn("Budget hit") if @usage >= @budget
    end
  end

  def unsubscribe
    @subscriptions.each { |id| DSPy.events.unsubscribe(id) }
    @subscriptions.clear
  end
end
```

### Clearing Listeners in Tests

Call `DSPy.events.clear_listeners` in `before`/`after` blocks to prevent cross-contamination between test cases:

```ruby
RSpec.configure do |config|
  config.after(:each) { DSPy.events.clear_listeners }
end
```

## dspy-o11y Gems

Three gems compose the observability stack:

| Gem | Purpose |
|---|---|
| `dspy` | Core event bus (`DSPy.event`, `DSPy.events`) -- always available |
| `dspy-o11y` | OpenTelemetry spans, `AsyncSpanProcessor`, `DSPy::Context.with_span` helpers |
| `dspy-o11y-langfuse` | Langfuse adapter -- configures OTLP exporter targeting Langfuse endpoints |

### Installation

```ruby
# Gemfile
gem 'dspy'
gem 'dspy-o11y'           # core spans + helpers
gem 'dspy-o11y-langfuse'  # Langfuse/OpenTelemetry adapter (optional)
```

If the optional gems are absent, DSPy falls back to logging-only mode with no errors.

## Langfuse Integration

### Environment Variables

```bash
# Required
export LANGFUSE_PUBLIC_KEY=pk-lf-your-public-key
export LANGFUSE_SECRET_KEY=sk-lf-your-secret-key

# Optional (defaults to https://cloud.langfuse.com)
export LANGFUSE_HOST=https://us.cloud.langfuse.com

# Tuning (optional)
export DSPY_TELEMETRY_BATCH_SIZE=100        # spans per export batch (default 100)
export DSPY_TELEMETRY_QUEUE_SIZE=1000       # max queued spans (default 1000)
export DSPY_TELEMETRY_EXPORT_INTERVAL=60    # seconds between timed exports (default 60)
export DSPY_TELEMETRY_SHUTDOWN_TIMEOUT=10   # seconds to drain on shutdown (default 10)
```

### Automatic Configuration

Call `DSPy::Observability.configure!` once at boot (it is already called automatically when `require 'dspy'` runs and Langfuse env vars are present):

```ruby
require 'dspy'
# If LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set,
# DSPy::Observability.configure! runs automatically and:
#   1. Configures the OpenTelemetry SDK with an OTLP exporter
#   2. Creates dual output: structured logs AND OpenTelemetry spans
#   3. Exports spans to Langfuse using proper authentication
#   4. Falls back gracefully if gems are missing
```

Verify status with `DSPy::Observability.enabled?`.

### Automatic Tracing

With observability enabled, every `DSPy::Module#forward` call, LM request, and tool invocation creates properly nested spans. Langfuse receives hierarchical traces:

```
Trace: abc-123-def
+-- ChainOfThought.forward [2000ms]  (observation type: chain)
    +-- llm.generate [1000ms]        (observation type: generation)
        Model: gpt-4-0613
        Tokens: 100 in / 50 out / 150 total
```

DSPy maps module classes to Langfuse observation types automatically via `DSPy::ObservationType.for_module_class`:

| Module | Observation Type |
|---|---|
| `DSPy::LM` (raw chat) | `generation` |
| `DSPy::ChainOfThought` | `chain` |
| `DSPy::ReAct` | `agent` |
| Tool invocations | `tool` |
| Memory/retrieval | `retriever` |
| Embedding engines | `embedding` |
| Evaluation modules | `evaluator` |
| Generic operations | `span` |

## Score Reporting

### DSPy.score API

Report evaluation scores with `DSPy.score`:

```ruby
# Numeric (default)
DSPy.score('accuracy', 0.95)

# With comment
DSPy.score('relevance', 0.87, comment: 'High semantic similarity')

# Boolean
DSPy.score('is_valid', 1, data_type: DSPy::Scores::DataType::Boolean)

# Categorical
DSPy.score('sentiment', 'positive', data_type: DSPy::Scores::DataType::Categorical)

# Explicit trace binding
DSPy.score('accuracy', 0.95, trace_id: 'custom-trace-id')
```

Available data types: `DSPy::Scores::DataType::Numeric`, `::Boolean`, `::Categorical`.

### score.create Events

Every `DSPy.score` call emits a `'score.create'` event. Subscribe to react:

```ruby
DSPy.events.subscribe('score.create') do |event_name, attrs|
  puts "#{attrs[:score_name]} = #{attrs[:score_value]}"
  # Also available: attrs[:score_id], attrs[:score_data_type],
  # attrs[:score_comment], attrs[:trace_id], attrs[:observation_id],
  # attrs[:timestamp]
end
```

### Async Langfuse Export with DSPy::Scores::Exporter

Configure the exporter to send scores to Langfuse in the background:

```ruby
exporter = DSPy::Scores::Exporter.configure(
  public_key: ENV['LANGFUSE_PUBLIC_KEY'],
  secret_key: ENV['LANGFUSE_SECRET_KEY'],
  host: 'https://cloud.langfuse.com'
)

# Scores are now exported automatically via a background Thread::Queue
DSPy.score('accuracy', 0.95)

# Shut down gracefully (waits up to 5 seconds by default)
exporter.shutdown
```

The exporter subscribes to `'score.create'` events internally, queues them for async processing, and retries with exponential backoff on failure.

### Automatic Export with DSPy::Evals

Pass `export_scores: true` to `DSPy::Evals` to export per-example scores and an aggregate batch score automatically:

```ruby
evaluator = DSPy::Evals.new(
  program,
  metric: my_metric,
  export_scores: true,
  score_name: 'qa_accuracy'
)

result = evaluator.evaluate(test_examples)
```

## DSPy::Context.with_span

Create manual spans for custom operations. Requires `dspy-o11y`.

```ruby
DSPy::Context.with_span(operation: 'custom.retrieval', 'retrieval.source' => 'pinecone') do |span|
  results = pinecone_client.query(embedding)
  span&.set_attribute('retrieval.count', results.size) if span
  results
end
```

Pass semantic attributes as keyword arguments alongside `operation:`. The block receives an OpenTelemetry span object (or `nil` when observability is disabled). The span automatically nests under the current parent span and records `duration.ms`, `langfuse.observation.startTime`, and `langfuse.observation.endTime`.

Assign a Langfuse observation type to custom spans:

```ruby
DSPy::Context.with_span(
  operation: 'evaluate.batch',
  **DSPy::ObservationType::Evaluator.langfuse_attributes,
  'batch.size' => examples.length
) do |span|
  run_evaluation(examples)
end
```

Scores reported inside a `with_span` block automatically inherit the current trace context.

## Module Stack Metadata

When `DSPy::Module#forward` runs, the context layer maintains a module stack. Every event includes:

```ruby
{
  module_path: [
    { id: "root_uuid",    class: "DeepSearch",    label: nil },
    { id: "planner_uuid", class: "DSPy::Predict", label: "planner" }
  ],
  module_root: { id: "root_uuid", class: "DeepSearch", label: nil },
  module_leaf: { id: "planner_uuid", class: "DSPy::Predict", label: "planner" },
  module_scope: {
    ancestry_token: "root_uuid>planner_uuid",
    depth: 2
  }
}
```

| Key | Meaning |
|---|---|
| `module_path` | Ordered array of `{id, class, label}` entries from root to leaf |
| `module_root` | The outermost module in the current call chain |
| `module_leaf` | The innermost (currently executing) module |
| `module_scope.ancestry_token` | Stable string of joined UUIDs representing the nesting path |
| `module_scope.depth` | Integer depth of the current module in the stack |

Labels are set via `module_scope_label=` on a module instance or derived automatically from named predictors. Use this metadata to power Langfuse filters, scoped metrics, or custom event routing.

## Dedicated Export Worker

The `DSPy::Observability::AsyncSpanProcessor` (from `dspy-o11y`) keeps telemetry export off the hot path:

- Runs on a `Concurrent::SingleThreadExecutor` -- LLM workflows never compete with OTLP networking.
- Buffers finished spans in a `Thread::Queue` (max size configurable via `DSPY_TELEMETRY_QUEUE_SIZE`).
- Drains spans in batches of `DSPY_TELEMETRY_BATCH_SIZE` (default 100). When the queue reaches batch size, an immediate async export fires.
- A background timer thread triggers periodic export every `DSPY_TELEMETRY_EXPORT_INTERVAL` seconds (default 60).
- Applies exponential backoff (`0.1 * 2^attempt` seconds) on export failures, up to `DEFAULT_MAX_RETRIES` (3).
- On shutdown, flushes all remaining spans within `DSPY_TELEMETRY_SHUTDOWN_TIMEOUT` seconds, then terminates the executor.
- Drops the oldest span when the queue is full, logging `'observability.span_dropped'`.

No application code interacts with the processor directly. Configure it entirely through environment variables.

## Built-in Events Reference

| Event Name | Emitted By | Key Attributes |
|---|---|---|
| `lm.tokens` | `DSPy::LM` | `gen_ai.system`, `gen_ai.request.model`, `input_tokens`, `output_tokens`, `total_tokens` |
| `chain_of_thought.reasoning_complete` | `DSPy::ChainOfThought` | `dspy.signature`, `cot.reasoning_steps`, `cot.reasoning_length`, `cot.has_reasoning` |
| `react.iteration_complete` | `DSPy::ReAct` | `iteration`, `thought`, `action`, `observation` |
| `codeact.iteration_complete` | `dspy-code_act` gem | `iteration`, `code_executed`, `execution_result` |
| `optimization.trial_complete` | Teleprompters (MIPROv2) | `trial_number`, `score` |
| `score.create` | `DSPy.score` | `score_name`, `score_value`, `score_data_type`, `trace_id` |
| `span.start` | `DSPy::Context.with_span` | `trace_id`, `span_id`, `parent_span_id`, `operation` |

## Best Practices

- Use dot-separated string names for events. Follow OpenTelemetry `gen_ai.*` conventions for LLM attributes.
- Always call `unsubscribe` (or `unsubscribe_module_events` for scoped subscriptions) when a tracker is no longer needed to prevent memory leaks.
- Call `DSPy.events.clear_listeners` in test teardown to avoid cross-contamination.
- Wrap risky listener logic in a rescue block. The event system isolates listener failures, but explicit rescue prevents silent swallowing of domain errors.
- Prefer module-scoped `subscribe` for agent internals. Reserve global `DSPy.events.subscribe` for infrastructure-level concerns.
