# DSPy.rb Core Concepts

## Signatures

Signatures define the interface between application code and language models. They specify inputs, outputs, and a task description using Sorbet types for compile-time and runtime type safety.

### Structure

```ruby
class ClassifyEmail < DSPy::Signature
  description "Classify customer support emails by urgency and category"

  input do
    const :subject, String
    const :body, String
  end

  output do
    const :category, String
    const :urgency, String
  end
end
```

### Supported Types

| Type | JSON Schema | Notes |
|------|-------------|-------|
| `String` | `string` | Required string |
| `Integer` | `integer` | Whole numbers |
| `Float` | `number` | Decimal numbers |
| `T::Boolean` | `boolean` | true/false |
| `T::Array[X]` | `array` | Typed arrays |
| `T::Hash[K, V]` | `object` | Typed key-value maps |
| `T.nilable(X)` | nullable | Optional fields |
| `Date` | `string` (ISO 8601) | Auto-converted |
| `DateTime` | `string` (ISO 8601) | Preserves timezone |
| `Time` | `string` (ISO 8601) | Converted to UTC |

### Date and Time Types

Date, DateTime, and Time fields serialize to ISO 8601 strings and auto-convert back to Ruby objects on output.

```ruby
class EventScheduler < DSPy::Signature
  description "Schedule events based on requirements"

  input do
    const :start_date, Date                  # ISO 8601: YYYY-MM-DD
    const :preferred_time, DateTime          # ISO 8601 with timezone
    const :deadline, Time                    # Converted to UTC
    const :end_date, T.nilable(Date)         # Optional date
  end

  output do
    const :scheduled_date, Date              # String from LLM, auto-converted to Date
    const :event_datetime, DateTime          # Preserves timezone info
    const :created_at, Time                  # Converted to UTC
  end
end

predictor = DSPy::Predict.new(EventScheduler)
result = predictor.call(
  start_date: "2024-01-15",
  preferred_time: "2024-01-15T10:30:45Z",
  deadline: Time.now,
  end_date: nil
)

result.scheduled_date.class  # => Date
result.event_datetime.class  # => DateTime
```

Timezone conventions follow ActiveRecord: Time objects convert to UTC, DateTime objects preserve timezone, Date objects are timezone-agnostic.

### Enums with T::Enum

Define constrained output values using `T::Enum` classes. Do not use inline `T.enum([...])` syntax.

```ruby
class SentimentAnalysis < DSPy::Signature
  description "Analyze sentiment of text"

  class Sentiment < T::Enum
    enums do
      Positive = new('positive')
      Negative = new('negative')
      Neutral = new('neutral')
    end
  end

  input do
    const :text, String
  end

  output do
    const :sentiment, Sentiment
    const :confidence, Float
  end
end

predictor = DSPy::Predict.new(SentimentAnalysis)
result = predictor.call(text: "This product is amazing!")

result.sentiment              # => #<Sentiment::Positive>
result.sentiment.serialize    # => "positive"
result.confidence             # => 0.92
```

Enum matching is case-insensitive. The LLM returning `"POSITIVE"` matches `new('positive')`.

### Default Values

Default values work on both inputs and outputs. Input defaults reduce caller boilerplate. Output defaults provide fallbacks when the LLM omits optional fields.

```ruby
class SmartSearch < DSPy::Signature
  description "Search with intelligent defaults"

  input do
    const :query, String
    const :max_results, Integer, default: 10
    const :language, String, default: "English"
  end

  output do
    const :results, T::Array[String]
    const :total_found, Integer
    const :cached, T::Boolean, default: false
  end
end

search = DSPy::Predict.new(SmartSearch)
result = search.call(query: "Ruby programming")
# max_results defaults to 10, language defaults to "English"
# If LLM omits `cached`, it defaults to false
```

### Field Descriptions

Add `description:` to any field to guide the LLM on expected content. These descriptions appear in the generated JSON schema sent to the model.

```ruby
class ASTNode < T::Struct
  const :node_type, String, description: "The type of AST node (heading, paragraph, code_block)"
  const :text, String, default: "", description: "Text content of the node"
  const :level, Integer, default: 0, description: "Heading level 1-6, only for heading nodes"
  const :children, T::Array[ASTNode], default: []
end

ASTNode.field_descriptions[:node_type]  # => "The type of AST node ..."
ASTNode.field_descriptions[:children]   # => nil (no description set)
```

Field descriptions also work inside signature `input` and `output` blocks:

```ruby
class ExtractEntities < DSPy::Signature
  description "Extract named entities from text"

  input do
    const :text, String, description: "Raw text to analyze"
    const :language, String, default: "en", description: "ISO 639-1 language code"
  end

  output do
    const :entities, T::Array[String], description: "List of extracted entity names"
    const :count, Integer, description: "Total number of unique entities found"
  end
end
```

### Schema Formats

DSPy.rb supports three schema formats for communicating type structure to LLMs.

#### JSON Schema (default)

Verbose but universally supported. Access via `YourSignature.output_json_schema`.

#### BAML Schema

Compact format that reduces schema tokens by 80-85%. Requires the `sorbet-baml` gem.

```ruby
DSPy.configure do |c|
  c.lm = DSPy::LM.new('openai/gpt-4o-mini',
    api_key: ENV['OPENAI_API_KEY'],
    schema_format: :baml
  )
end
```

BAML applies only in Enhanced Prompting mode (`structured_outputs: false`). When `structured_outputs: true`, the provider receives JSON Schema directly.

#### TOON Schema + Data Format

Table-oriented text format that shrinks both schema definitions and prompt values.

```ruby
DSPy.configure do |c|
  c.lm = DSPy::LM.new('openai/gpt-4o-mini',
    api_key: ENV['OPENAI_API_KEY'],
    schema_format: :toon,
    data_format:   :toon
  )
end
```

`schema_format: :toon` replaces the schema block in the system prompt. `data_format: :toon` renders input values and output templates inside `toon` fences. Only works with Enhanced Prompting mode. The `sorbet-toon` gem is included automatically as a dependency.

### Recursive Types

Structs that reference themselves produce `$defs` entries in the generated JSON schema, using `$ref` pointers to avoid infinite recursion.

```ruby
class ASTNode < T::Struct
  const :node_type, String
  const :text, String, default: ""
  const :children, T::Array[ASTNode], default: []
end
```

The schema generator detects the self-reference in `T::Array[ASTNode]` and emits:

```json
{
  "$defs": {
    "ASTNode": { "type": "object", "properties": { ... } }
  },
  "properties": {
    "children": {
      "type": "array",
      "items": { "$ref": "#/$defs/ASTNode" }
    }
  }
}
```

Access the schema with accumulated definitions via `YourSignature.output_json_schema_with_defs`.

### Union Types with T.any()

Specify fields that accept multiple types:

```ruby
output do
  const :result, T.any(Float, String)
end
```

For struct unions, DSPy.rb automatically adds a `_type` discriminator field to each struct's JSON schema. The LLM returns `_type` in its response, and DSPy converts the hash to the correct struct instance.

```ruby
class CreateTask < T::Struct
  const :title, String
  const :priority, String
end

class DeleteTask < T::Struct
  const :task_id, String
  const :reason, T.nilable(String)
end

class TaskRouter < DSPy::Signature
  description "Route user request to the appropriate task action"

  input do
    const :request, String
  end

  output do
    const :action, T.any(CreateTask, DeleteTask)
  end
end

result = DSPy::Predict.new(TaskRouter).call(request: "Create a task for Q4 review")
result.action.class  # => CreateTask
result.action.title  # => "Q4 Review"
```

Pattern matching works on the result:

```ruby
case result.action
when CreateTask then puts "Creating: #{result.action.title}"
when DeleteTask then puts "Deleting: #{result.action.task_id}"
end
```

Union types also work inside arrays for heterogeneous collections:

```ruby
output do
  const :events, T::Array[T.any(LoginEvent, PurchaseEvent)]
end
```

Limit unions to 2-4 types for reliable LLM comprehension. Use clear struct names since they become the `_type` discriminator values.

---

## Modules

Modules are composable building blocks that wrap predictors. Define a `forward` method; invoke the module with `.call()`.

### Basic Structure

```ruby
class SentimentAnalyzer < DSPy::Module
  def initialize
    super
    @predictor = DSPy::Predict.new(SentimentSignature)
  end

  def forward(text:)
    @predictor.call(text: text)
  end
end

analyzer = SentimentAnalyzer.new
result = analyzer.call(text: "I love this product!")

result.sentiment    # => "positive"
result.confidence   # => 0.9
```

**API rules:**
- Invoke modules and predictors with `.call()`, not `.forward()`.
- Access result fields with `result.field`, not `result[:field]`.

### Module Composition

Combine multiple modules through explicit method calls in `forward`:

```ruby
class DocumentProcessor < DSPy::Module
  def initialize
    super
    @classifier = DocumentClassifier.new
    @summarizer = DocumentSummarizer.new
  end

  def forward(document:)
    classification = @classifier.call(content: document)
    summary = @summarizer.call(content: document)

    {
      document_type: classification.document_type,
      summary: summary.summary
    }
  end
end
```

### Lifecycle Callbacks

Modules support `before`, `after`, and `around` callbacks on `forward`. Declare them as class-level macros referencing private methods.

#### Execution order

1. `before` callbacks (in registration order)
2. `around` callbacks (before `yield`)
3. `forward` method
4. `around` callbacks (after `yield`)
5. `after` callbacks (in registration order)

```ruby
class InstrumentedModule < DSPy::Module
  before :setup_metrics
  after :log_metrics
  around :manage_context

  def initialize
    super
    @predictor = DSPy::Predict.new(MySignature)
    @metrics = {}
  end

  def forward(question:)
    @predictor.call(question: question)
  end

  private

  def setup_metrics
    @metrics[:start_time] = Time.now
  end

  def manage_context
    load_context
    result = yield
    save_context
    result
  end

  def log_metrics
    @metrics[:duration] = Time.now - @metrics[:start_time]
  end
end
```

Multiple callbacks of the same type execute in registration order. Callbacks inherit from parent classes; parent callbacks run first.

#### Around callbacks

Around callbacks must call `yield` to execute the wrapped method and return the result:

```ruby
def with_retry
  retries = 0
  begin
    yield
  rescue StandardError => e
    retries += 1
    retry if retries < 3
    raise e
  end
end
```

### Instruction Update Contract

Teleprompters (GEPA, MIPROv2) require modules to expose immutable update hooks. Include `DSPy::Mixins::InstructionUpdatable` and implement `with_instruction` and `with_examples`, each returning a new instance:

```ruby
class SentimentPredictor < DSPy::Module
  include DSPy::Mixins::InstructionUpdatable

  def initialize
    super
    @predictor = DSPy::Predict.new(SentimentSignature)
  end

  def with_instruction(instruction)
    clone = self.class.new
    clone.instance_variable_set(:@predictor, @predictor.with_instruction(instruction))
    clone
  end

  def with_examples(examples)
    clone = self.class.new
    clone.instance_variable_set(:@predictor, @predictor.with_examples(examples))
    clone
  end
end
```

If a module omits these hooks, teleprompters raise `DSPy::InstructionUpdateError` instead of silently mutating state.

---

## Predictors

Predictors are execution engines that take a signature and produce structured results from a language model. DSPy.rb provides four predictor types.

### Predict

Direct LLM call with typed input/output. Fastest option, lowest token usage.

```ruby
classifier = DSPy::Predict.new(ClassifyText)
result = classifier.call(text: "Technical document about APIs")

result.sentiment    # => #<Sentiment::Positive>
result.topics       # => ["APIs", "technical"]
result.confidence   # => 0.92
```

### ChainOfThought

Adds a `reasoning` field to the output automatically. The model generates step-by-step reasoning before the final answer. Do not define a `:reasoning` field in the signature output when using ChainOfThought.

```ruby
class SolveMathProblem < DSPy::Signature
  description "Solve mathematical word problems step by step"

  input do
    const :problem, String
  end

  output do
    const :answer, String
    # :reasoning is added automatically by ChainOfThought
  end
end

solver = DSPy::ChainOfThought.new(SolveMathProblem)
result = solver.call(problem: "Sarah has 15 apples. She gives 7 away and buys 12 more.")

result.reasoning  # => "Step by step: 15 - 7 = 8, then 8 + 12 = 20"
result.answer     # => "20 apples"
```

Use ChainOfThought for complex analysis, multi-step reasoning, or when explainability matters.

### ReAct

Reasoning + Action agent that uses tools in an iterative loop. Define tools by subclassing `DSPy::Tools::Base`. Group related tools with `DSPy::Tools::Toolset`.

```ruby
class WeatherTool < DSPy::Tools::Base
  extend T::Sig

  tool_name "weather"
  tool_description "Get weather information for a location"

  sig { params(location: String).returns(String) }
  def call(location:)
    { location: location, temperature: 72, condition: "sunny" }.to_json
  end
end

class TravelSignature < DSPy::Signature
  description "Help users plan travel"

  input do
    const :destination, String
  end

  output do
    const :recommendations, String
  end
end

agent = DSPy::ReAct.new(
  TravelSignature,
  tools: [WeatherTool.new],
  max_iterations: 5
)

result = agent.call(destination: "Tokyo, Japan")
result.recommendations  # => "Visit Senso-ji Temple early morning..."
result.history          # => Array of reasoning steps, actions, observations
result.iterations       # => 3
result.tools_used       # => ["weather"]
```

Use toolsets to expose multiple tool methods from a single class:

```ruby
text_tools = DSPy::Tools::TextProcessingToolset.to_tools
agent = DSPy::ReAct.new(MySignature, tools: text_tools)
```

### CodeAct

Think-Code-Observe agent that synthesizes and executes Ruby code. Ships as a separate gem.

```ruby
# Gemfile
gem 'dspy-code_act', '~> 0.29'
```

```ruby
programmer = DSPy::CodeAct.new(ProgrammingSignature, max_iterations: 10)
result = programmer.call(task: "Calculate the factorial of 20")
```

### Predictor Comparison

| Predictor | Speed | Token Usage | Best For |
|-----------|-------|-------------|----------|
| Predict | Fastest | Low | Classification, extraction |
| ChainOfThought | Moderate | Medium-High | Complex reasoning, analysis |
| ReAct | Slower | High | Multi-step tasks with tools |
| CodeAct | Slowest | Very High | Dynamic programming, calculations |

### Concurrent Predictions

Process multiple independent predictions simultaneously using `Async::Barrier`:

```ruby
require 'async'
require 'async/barrier'

analyzer = DSPy::Predict.new(ContentAnalyzer)
documents = ["Text one", "Text two", "Text three"]

Async do
  barrier = Async::Barrier.new

  tasks = documents.map do |doc|
    barrier.async { analyzer.call(content: doc) }
  end

  barrier.wait
  predictions = tasks.map(&:wait)

  predictions.each { |p| puts p.sentiment }
end
```

Add `gem 'async', '~> 2.29'` to the Gemfile. Handle errors within each `barrier.async` block to prevent one failure from cancelling others:

```ruby
barrier.async do
  begin
    analyzer.call(content: doc)
  rescue StandardError => e
    nil
  end
end
```

### Few-Shot Examples and Instruction Tuning

```ruby
classifier = DSPy::Predict.new(SentimentAnalysis)

examples = [
  DSPy::FewShotExample.new(
    input: { text: "Love it!" },
    output: { sentiment: "positive", confidence: 0.95 }
  )
]

optimized = classifier.with_examples(examples)
tuned = classifier.with_instruction("Be precise and confident.")
```

---

## Type System

### Automatic Type Conversion

DSPy.rb v0.9.0+ automatically converts LLM JSON responses to typed Ruby objects:

- **Enums**: String values become `T::Enum` instances (case-insensitive)
- **Structs**: Nested hashes become `T::Struct` objects
- **Arrays**: Elements convert recursively
- **Defaults**: Missing fields use declared defaults

### Discriminators for Union Types

When a field uses `T.any()` with struct types, DSPy adds a `_type` field to each struct's schema. On deserialization, `_type` selects the correct struct class:

```json
{
  "action": {
    "_type": "CreateTask",
    "title": "Review Q4 Report"
  }
}
```

DSPy matches `"CreateTask"` against the union members and instantiates the correct struct. No manual discriminator field is needed.

### Recursive Types

Structs referencing themselves are supported. The schema generator tracks visited types and produces `$ref` pointers under `$defs`:

```ruby
class TreeNode < T::Struct
  const :label, String
  const :children, T::Array[TreeNode], default: []
end
```

The generated schema uses `"$ref": "#/$defs/TreeNode"` for the children array items, preventing infinite schema expansion.

### Nesting Depth

- 1-2 levels: reliable across all providers.
- 3-4 levels: works but increases schema complexity.
- 5+ levels: may trigger OpenAI depth validation warnings and reduce LLM accuracy. Flatten deeply nested structures or split into multiple signatures.

### Tips

- Prefer `T::Array[X], default: []` over `T.nilable(T::Array[X])` -- the nilable form causes schema issues with OpenAI structured outputs.
- Use clear struct names for union types since they become `_type` discriminator values.
- Limit union types to 2-4 members for reliable model comprehension.
- Check schema compatibility with `DSPy::OpenAI::LM::SchemaConverter.validate_compatibility(schema)`.
