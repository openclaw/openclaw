# DSPy.rb Toolsets

## Tools::Base

`DSPy::Tools::Base` is the base class for single-purpose tools. Each subclass exposes one operation to an LLM agent through a `call` method.

### Defining a Tool

Set the tool's identity with the `tool_name` and `tool_description` class-level DSL methods. Define the `call` instance method with a Sorbet `sig` declaration so DSPy.rb can generate the JSON schema the LLM uses to invoke the tool.

```ruby
class WeatherLookup < DSPy::Tools::Base
  extend T::Sig

  tool_name "weather_lookup"
  tool_description "Look up current weather for a given city"

  sig { params(city: String, units: T.nilable(String)).returns(String) }
  def call(city:, units: nil)
    # Fetch weather data and return a string summary
    "72F and sunny in #{city}"
  end
end
```

Key points:

- Inherit from `DSPy::Tools::Base`, not `DSPy::Tool`.
- Use `tool_name` (class method) to set the name the LLM sees. Without it, the class name is lowercased as a fallback.
- Use `tool_description` (class method) to set the human-readable description surfaced in the tool schema.
- The `call` method must use **keyword arguments**. Positional arguments are supported but keyword arguments produce better schemas.
- Always attach a Sorbet `sig` to `call`. Without a signature, the generated schema has empty properties and the LLM cannot determine parameter types.

### Schema Generation

`call_schema_object` introspects the Sorbet signature on `call` and returns a hash representing the JSON Schema `parameters` object:

```ruby
WeatherLookup.call_schema_object
# => {
#   type: "object",
#   properties: {
#     city:  { type: "string", description: "Parameter city" },
#     units: { type: "string", description: "Parameter units (optional)" }
#   },
#   required: ["city"]
# }
```

`call_schema` wraps this in the full LLM tool-calling format:

```ruby
WeatherLookup.call_schema
# => {
#   type: "function",
#   function: {
#     name: "call",
#     description: "Call the WeatherLookup tool",
#     parameters: { ... }
#   }
# }
```

### Using Tools with ReAct

Pass tool instances in an array to `DSPy::ReAct`:

```ruby
agent = DSPy::ReAct.new(
  MySignature,
  tools: [WeatherLookup.new, AnotherTool.new]
)

result = agent.call(question: "What is the weather in Berlin?")
puts result.answer
```

Access output fields with dot notation (`result.answer`), not hash access (`result[:answer]`).

---

## Tools::Toolset

`DSPy::Tools::Toolset` groups multiple related methods into a single class. Each exposed method becomes an independent tool from the LLM's perspective.

### Defining a Toolset

```ruby
class DatabaseToolset < DSPy::Tools::Toolset
  extend T::Sig

  toolset_name "db"

  tool :query,  description: "Run a read-only SQL query"
  tool :insert, description: "Insert a record into a table"
  tool :delete, description: "Delete a record by ID"

  sig { params(sql: String).returns(String) }
  def query(sql:)
    # Execute read query
  end

  sig { params(table: String, data: T::Hash[String, String]).returns(String) }
  def insert(table:, data:)
    # Insert record
  end

  sig { params(table: String, id: Integer).returns(String) }
  def delete(table:, id:)
    # Delete record
  end
end
```

### DSL Methods

**`toolset_name(name)`** -- Set the prefix for all generated tool names. If omitted, the class name minus `Toolset` suffix is lowercased (e.g., `DatabaseToolset` becomes `database`).

```ruby
toolset_name "db"
# tool :query produces a tool named "db_query"
```

**`tool(method_name, tool_name:, description:)`** -- Expose a method as a tool.

- `method_name` (Symbol, required) -- the instance method to expose.
- `tool_name:` (String, optional) -- override the default `<toolset_name>_<method_name>` naming.
- `description:` (String, optional) -- description shown to the LLM. Defaults to a humanized version of the method name.

```ruby
tool :word_count, tool_name: "text_wc", description: "Count lines, words, and characters"
# Produces a tool named "text_wc" instead of "text_word_count"
```

### Converting to a Tool Array

Call `to_tools` on the class (not an instance) to get an array of `ToolProxy` objects compatible with `DSPy::Tools::Base`:

```ruby
agent = DSPy::ReAct.new(
  AnalyzeText,
  tools: DatabaseToolset.to_tools
)
```

Each `ToolProxy` wraps one method, delegates `call` to the underlying toolset instance, and generates its own JSON schema from the method's Sorbet signature.

### Shared State

All tool proxies from a single `to_tools` call share one toolset instance. Store shared state (connections, caches, configuration) in the toolset's `initialize`:

```ruby
class ApiToolset < DSPy::Tools::Toolset
  extend T::Sig

  toolset_name "api"

  tool :get,  description: "Make a GET request"
  tool :post, description: "Make a POST request"

  sig { params(base_url: String).void }
  def initialize(base_url:)
    @base_url = base_url
    @client = HTTP.persistent(base_url)
  end

  sig { params(path: String).returns(String) }
  def get(path:)
    @client.get("#{@base_url}#{path}").body.to_s
  end

  sig { params(path: String, body: String).returns(String) }
  def post(path:, body:)
    @client.post("#{@base_url}#{path}", body: body).body.to_s
  end
end
```

---

## Type Safety

Sorbet signatures on tool methods drive both JSON schema generation and automatic type coercion of LLM responses.

### Basic Types

```ruby
sig { params(
  text: String,
  count: Integer,
  score: Float,
  enabled: T::Boolean,
  threshold: Numeric
).returns(String) }
def analyze(text:, count:, score:, enabled:, threshold:)
  # ...
end
```

| Sorbet Type      | JSON Schema                                        |
|------------------|----------------------------------------------------|
| `String`         | `{"type": "string"}`                               |
| `Integer`        | `{"type": "integer"}`                              |
| `Float`          | `{"type": "number"}`                               |
| `Numeric`        | `{"type": "number"}`                               |
| `T::Boolean`     | `{"type": "boolean"}`                              |
| `T::Enum`        | `{"type": "string", "enum": [...]}`                |
| `T::Struct`      | `{"type": "object", "properties": {...}}`          |
| `T::Array[Type]` | `{"type": "array", "items": {...}}`                |
| `T::Hash[K, V]`  | `{"type": "object", "additionalProperties": {...}}`|
| `T.nilable(Type)`| `{"type": [original, "null"]}`                     |
| `T.any(T1, T2)`  | `{"oneOf": [{...}, {...}]}`                        |
| `T.class_of(X)`  | `{"type": "string"}`                               |

### T::Enum Parameters

Define a `T::Enum` and reference it in a tool signature. DSPy.rb generates a JSON Schema `enum` constraint and automatically deserializes the LLM's string response into the correct enum instance.

```ruby
class Priority < T::Enum
  enums do
    Low = new('low')
    Medium = new('medium')
    High = new('high')
    Critical = new('critical')
  end
end

class Status < T::Enum
  enums do
    Pending = new('pending')
    InProgress = new('in-progress')
    Completed = new('completed')
  end
end

sig { params(priority: Priority, status: Status).returns(String) }
def update_task(priority:, status:)
  "Updated to #{priority.serialize} / #{status.serialize}"
end
```

The generated schema constrains the parameter to valid values:

```json
{
  "priority": {
    "type": "string",
    "enum": ["low", "medium", "high", "critical"]
  }
}
```

**Case-insensitive matching**: When the LLM returns `"HIGH"` or `"High"` instead of `"high"`, DSPy.rb first tries an exact `try_deserialize`, then falls back to a case-insensitive lookup. This prevents failures caused by LLM casing variations.

### T::Struct Parameters

Use `T::Struct` for complex nested objects. DSPy.rb generates nested JSON Schema properties and recursively coerces the LLM's hash response into struct instances.

```ruby
class TaskMetadata < T::Struct
  prop :id, String
  prop :priority, Priority
  prop :tags, T::Array[String]
  prop :estimated_hours, T.nilable(Float), default: nil
end

class TaskRequest < T::Struct
  prop :title, String
  prop :description, String
  prop :status, Status
  prop :metadata, TaskMetadata
  prop :assignees, T::Array[String]
end

sig { params(task: TaskRequest).returns(String) }
def create_task(task:)
  "Created: #{task.title} (#{task.status.serialize})"
end
```

The LLM sees the full nested object schema and DSPy.rb reconstructs the struct tree from the JSON response, including enum fields inside nested structs.

### Nilable Parameters

Mark optional parameters with `T.nilable(...)` and provide a default value of `nil` in the method signature. These parameters are excluded from the JSON Schema `required` array.

```ruby
sig { params(
  query: String,
  max_results: T.nilable(Integer),
  filter: T.nilable(String)
).returns(String) }
def search(query:, max_results: nil, filter: nil)
  # query is required; max_results and filter are optional
end
```

### Collections

Typed arrays and hashes generate precise item/value schemas:

```ruby
sig { params(
  tags: T::Array[String],
  priorities: T::Array[Priority],
  config: T::Hash[String, T.any(String, Integer, Float)]
).returns(String) }
def configure(tags:, priorities:, config:)
  # Array elements and hash values are validated and coerced
end
```

### Union Types

`T.any(...)` generates a `oneOf` JSON Schema. When one of the union members is a `T::Struct`, DSPy.rb uses the `_type` discriminator field to select the correct struct class during coercion.

```ruby
sig { params(value: T.any(String, Integer, Float)).returns(String) }
def handle_flexible(value:)
  # Accepts multiple types
end
```

---

## Built-in Toolsets

### TextProcessingToolset

`DSPy::Tools::TextProcessingToolset` provides Unix-style text analysis and manipulation operations. Toolset name prefix: `text`.

| Tool Name                         | Method            | Description                                |
|-----------------------------------|-------------------|--------------------------------------------|
| `text_grep`                       | `grep`            | Search for patterns with optional case-insensitive and count-only modes |
| `text_wc`                         | `word_count`      | Count lines, words, and characters         |
| `text_rg`                         | `ripgrep`         | Fast pattern search with context lines     |
| `text_extract_lines`              | `extract_lines`   | Extract a range of lines by number         |
| `text_filter_lines`               | `filter_lines`    | Keep or reject lines matching a regex      |
| `text_unique_lines`               | `unique_lines`    | Deduplicate lines, optionally preserving order |
| `text_sort_lines`                 | `sort_lines`      | Sort lines alphabetically or numerically   |
| `text_summarize_text`             | `summarize_text`  | Produce a statistical summary (counts, averages, frequent words) |

Usage:

```ruby
agent = DSPy::ReAct.new(
  AnalyzeText,
  tools: DSPy::Tools::TextProcessingToolset.to_tools
)

result = agent.call(text: log_contents, question: "How many error lines are there?")
puts result.answer
```

### GitHubCLIToolset

`DSPy::Tools::GitHubCLIToolset` wraps the `gh` CLI for read-oriented GitHub operations. Toolset name prefix: `github`.

| Tool Name              | Method            | Description                                       |
|------------------------|-------------------|---------------------------------------------------|
| `github_list_issues`   | `list_issues`     | List issues filtered by state, labels, assignee   |
| `github_list_prs`      | `list_prs`        | List pull requests filtered by state, author, base|
| `github_get_issue`     | `get_issue`       | Retrieve details of a single issue                |
| `github_get_pr`        | `get_pr`          | Retrieve details of a single pull request         |
| `github_api_request`   | `api_request`     | Make an arbitrary GET request to the GitHub API    |
| `github_traffic_views` | `traffic_views`   | Fetch repository traffic view counts              |
| `github_traffic_clones`| `traffic_clones`  | Fetch repository traffic clone counts             |

This toolset uses `T::Enum` parameters (`IssueState`, `PRState`, `ReviewState`) for state filters, demonstrating enum-based tool signatures in practice.

```ruby
agent = DSPy::ReAct.new(
  RepoAnalysis,
  tools: DSPy::Tools::GitHubCLIToolset.to_tools
)
```

---

## Testing

### Unit Testing Individual Tools

Test `DSPy::Tools::Base` subclasses by instantiating and calling `call` directly:

```ruby
RSpec.describe WeatherLookup do
  subject(:tool) { described_class.new }

  it "returns weather for a city" do
    result = tool.call(city: "Berlin")
    expect(result).to include("Berlin")
  end

  it "exposes the correct tool name" do
    expect(tool.name).to eq("weather_lookup")
  end

  it "generates a valid schema" do
    schema = described_class.call_schema_object
    expect(schema[:required]).to include("city")
    expect(schema[:properties]).to have_key(:city)
  end
end
```

### Unit Testing Toolsets

Test toolset methods directly on an instance. Verify tool generation with `to_tools`:

```ruby
RSpec.describe DatabaseToolset do
  subject(:toolset) { described_class.new }

  it "executes a query" do
    result = toolset.query(sql: "SELECT 1")
    expect(result).to be_a(String)
  end

  it "generates tools with correct names" do
    tools = described_class.to_tools
    names = tools.map(&:name)
    expect(names).to contain_exactly("db_query", "db_insert", "db_delete")
  end

  it "generates tool descriptions" do
    tools = described_class.to_tools
    query_tool = tools.find { |t| t.name == "db_query" }
    expect(query_tool.description).to eq("Run a read-only SQL query")
  end
end
```

### Mocking Predictions Inside Tools

When a tool calls a DSPy predictor internally, stub the predictor to isolate tool logic from LLM calls:

```ruby
class SmartSearchTool < DSPy::Tools::Base
  extend T::Sig

  tool_name "smart_search"
  tool_description "Search with query expansion"

  sig { void }
  def initialize
    @expander = DSPy::Predict.new(QueryExpansionSignature)
  end

  sig { params(query: String).returns(String) }
  def call(query:)
    expanded = @expander.call(query: query)
    perform_search(expanded.expanded_query)
  end

  private

  def perform_search(query)
    # actual search logic
  end
end

RSpec.describe SmartSearchTool do
  subject(:tool) { described_class.new }

  before do
    expansion_result = double("result", expanded_query: "expanded test query")
    allow_any_instance_of(DSPy::Predict).to receive(:call).and_return(expansion_result)
  end

  it "expands the query before searching" do
    allow(tool).to receive(:perform_search).with("expanded test query").and_return("found 3 results")
    result = tool.call(query: "test")
    expect(result).to eq("found 3 results")
  end
end
```

### Testing Enum Coercion

Verify that string values from LLM responses deserialize into the correct enum instances:

```ruby
RSpec.describe "enum coercion" do
  it "handles case-insensitive enum values" do
    toolset = GitHubCLIToolset.new
    # The LLM may return "OPEN" instead of "open"
    result = toolset.list_issues(state: IssueState::Open)
    expect(result).to be_a(String)
  end
end
```

---

## Constraints

- All exposed tool methods must use **keyword arguments**. Positional-only parameters generate schemas but keyword arguments produce more reliable LLM interactions.
- Each exposed method becomes a **separate, independent tool**. Method chaining or multi-step sequences within a single tool call are not supported.
- Shared state across tool proxies is scoped to a single `to_tools` call. Separate `to_tools` invocations create separate toolset instances.
- Methods without a Sorbet `sig` produce an empty parameter schema. The LLM will not know what arguments to pass.
