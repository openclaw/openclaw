# frozen_string_literal: true

# =============================================================================
# DSPy.rb Module Template — v0.34.3 API
#
# Modules orchestrate predictors, tools, and business logic.
#
# Key patterns:
#   - Use .call() to invoke (not .forward())
#   - Access results with result.field (not result[:field])
#   - Use DSPy::Tools::Base for tools (not DSPy::Tool)
#   - Use lifecycle callbacks (before/around/after) for cross-cutting concerns
#   - Use DSPy.with_lm for temporary model overrides
#   - Use configure_predictor for fine-grained agent control
# =============================================================================

# --- Basic Module ---

class BasicClassifier < DSPy::Module
  def initialize
    super
    @predictor = DSPy::Predict.new(ClassificationSignature)
  end

  def forward(text:)
    @predictor.call(text: text)
  end
end

# Usage:
#   classifier = BasicClassifier.new
#   result = classifier.call(text: "This is a test")
#   result.category   # => "technical"
#   result.confidence  # => 0.95

# --- Module with Chain of Thought ---

class ReasoningClassifier < DSPy::Module
  def initialize
    super
    @predictor = DSPy::ChainOfThought.new(ClassificationSignature)
  end

  def forward(text:)
    result = @predictor.call(text: text)
    # ChainOfThought adds result.reasoning automatically
    result
  end
end

# --- Module with Lifecycle Callbacks ---

class InstrumentedModule < DSPy::Module
  before :setup_metrics
  around :manage_context
  after :log_completion

  def initialize
    super
    @predictor = DSPy::Predict.new(AnalysisSignature)
    @start_time = nil
  end

  def forward(query:)
    @predictor.call(query: query)
  end

  private

  # Runs before forward
  def setup_metrics
    @start_time = Time.now
    Rails.logger.info "Starting prediction"
  end

  # Wraps forward — must call yield
  def manage_context
    load_user_context
    result = yield
    save_updated_context(result)
    result
  end

  # Runs after forward completes
  def log_completion
    duration = Time.now - @start_time
    Rails.logger.info "Prediction completed in #{duration}s"
  end

  def load_user_context = nil
  def save_updated_context(_result) = nil
end

# Execution order: before → around (before yield) → forward → around (after yield) → after
# Callbacks are inherited from parent classes and execute in registration order.

# --- Module with Tools ---

class SearchTool < DSPy::Tools::Base
  tool_name "search"
  tool_description "Search for information by query"

  sig { params(query: String, max_results: Integer).returns(T::Array[T::Hash[Symbol, String]]) }
  def call(query:, max_results: 5)
    # Implementation here
    [{ title: "Result 1", url: "https://example.com" }]
  end
end

class FinishTool < DSPy::Tools::Base
  tool_name "finish"
  tool_description "Submit the final answer"

  sig { params(answer: String).returns(String) }
  def call(answer:)
    answer
  end
end

class ResearchAgent < DSPy::Module
  def initialize
    super
    tools = [SearchTool.new, FinishTool.new]
    @agent = DSPy::ReAct.new(
      ResearchSignature,
      tools: tools,
      max_iterations: 5
    )
  end

  def forward(question:)
    @agent.call(question: question)
  end
end

# --- Module with Per-Task Model Selection ---

class SmartRouter < DSPy::Module
  def initialize
    super
    @classifier = DSPy::Predict.new(RouteSignature)
    @analyzer = DSPy::ChainOfThought.new(AnalysisSignature)
  end

  def forward(text:)
    # Use fast model for classification
    DSPy.with_lm(fast_model) do
      route = @classifier.call(text: text)

      if route.requires_deep_analysis
        # Switch to powerful model for analysis
        DSPy.with_lm(powerful_model) do
          @analyzer.call(text: text)
        end
      else
        route
      end
    end
  end

  private

  def fast_model
    @fast_model ||= DSPy::LM.new(
      ENV.fetch("DSPY_SELECTOR_MODEL", "ruby_llm/gemini-2.5-flash-lite"),
      structured_outputs: true
    )
  end

  def powerful_model
    @powerful_model ||= DSPy::LM.new(
      ENV.fetch("DSPY_SYNTHESIZER_MODEL", "ruby_llm/gemini-2.5-flash"),
      structured_outputs: true
    )
  end
end

# --- Module with configure_predictor ---

class ConfiguredAgent < DSPy::Module
  def initialize
    super
    tools = [SearchTool.new, FinishTool.new]
    @agent = DSPy::ReAct.new(ResearchSignature, tools: tools)

    # Set default model for all internal predictors
    @agent.configure { |c| c.lm = DSPy::LM.new('ruby_llm/gemini-2.5-flash', structured_outputs: true) }

    # Override specific predictor with a more capable model
    @agent.configure_predictor('thought_generator') do |c|
      c.lm = DSPy::LM.new('ruby_llm/claude-sonnet-4-20250514', structured_outputs: true)
    end
  end

  def forward(question:)
    @agent.call(question: question)
  end
end

# Available internal predictors by agent type:
#   DSPy::ReAct      → thought_generator, observation_processor
#   DSPy::CodeAct    → code_generator, observation_processor
#   DSPy::DeepSearch → seed_predictor, search_predictor, reader_predictor, reason_predictor

# --- Module with Event Subscriptions ---

class TokenTrackingModule < DSPy::Module
  subscribe 'lm.tokens', :track_tokens, scope: :descendants

  def initialize
    super
    @predictor = DSPy::Predict.new(AnalysisSignature)
    @total_tokens = 0
  end

  def forward(query:)
    @predictor.call(query: query)
  end

  def track_tokens(_event, attrs)
    @total_tokens += attrs.fetch(:total_tokens, 0)
  end

  def token_usage
    @total_tokens
  end
end

# Module-scoped subscriptions automatically scope to the module instance and descendants.
# Use scope: :self_only to restrict delivery to the module itself (ignoring children).

# --- Tool That Wraps a Prediction ---

class RerankTool < DSPy::Tools::Base
  tool_name "rerank"
  tool_description "Score and rank search results by relevance"

  MAX_ITEMS = 200
  MIN_ITEMS_FOR_LLM = 5

  sig { params(query: String, items: T::Array[T::Hash[Symbol, T.untyped]]).returns(T::Hash[Symbol, T.untyped]) }
  def call(query:, items: [])
    # Short-circuit: skip LLM for small sets
    return { scored_items: items, reranked: false } if items.size < MIN_ITEMS_FOR_LLM

    # Cap to prevent token overflow
    capped_items = items.first(MAX_ITEMS)

    predictor = DSPy::Predict.new(RerankSignature)
    predictor.configure { |c| c.lm = DSPy::LM.new("ruby_llm/gemini-2.5-flash", structured_outputs: true) }

    result = predictor.call(query: query, items: capped_items)
    { scored_items: result.scored_items, reranked: true }
  rescue => e
    Rails.logger.warn "[RerankTool] LLM rerank failed: #{e.message}"
    { error: "Rerank failed: #{e.message}", scored_items: items, reranked: false }
  end
end

# Key patterns for tools wrapping predictions:
#   - Short-circuit LLM calls when unnecessary (small data, trivial cases)
#   - Cap input size to prevent token overflow
#   - Per-tool model selection via configure
#   - Graceful error handling with fallback data

# --- Multi-Step Pipeline ---

class AnalysisPipeline < DSPy::Module
  def initialize
    super
    @classifier = DSPy::Predict.new(ClassifySignature)
    @analyzer = DSPy::ChainOfThought.new(AnalyzeSignature)
    @summarizer = DSPy::Predict.new(SummarizeSignature)
  end

  def forward(text:)
    classification = @classifier.call(text: text)
    analysis = @analyzer.call(text: text, category: classification.category)
    @summarizer.call(analysis: analysis.reasoning, category: classification.category)
  end
end

# --- Observability with Spans ---

class TracedModule < DSPy::Module
  def initialize
    super
    @predictor = DSPy::Predict.new(AnalysisSignature)
  end

  def forward(query:)
    DSPy::Context.with_span(
      operation: "traced_module.analyze",
      "dspy.module" => self.class.name,
      "query.length" => query.length.to_s
    ) do
      @predictor.call(query: query)
    end
  end
end
