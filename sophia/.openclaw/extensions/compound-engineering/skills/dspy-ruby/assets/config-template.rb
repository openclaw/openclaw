# frozen_string_literal: true

# =============================================================================
# DSPy.rb Configuration Template — v0.34.3 API
#
# Rails initializer patterns for DSPy.rb with RubyLLM, observability,
# and feature-flagged model selection.
#
# Key patterns:
#   - Use after_initialize for Rails setup
#   - Use dspy-ruby_llm for multi-provider routing
#   - Use structured_outputs: true for reliable parsing
#   - Use dspy-o11y + dspy-o11y-langfuse for observability
#   - Use ENV-based feature flags for model selection
# =============================================================================

# =============================================================================
# Gemfile Dependencies
# =============================================================================
#
# # Core
# gem 'dspy'
#
# # Provider adapter (choose one strategy):
#
# # Strategy A: Unified adapter via RubyLLM (recommended)
# gem 'dspy-ruby_llm'
# gem 'ruby_llm'
#
# # Strategy B: Per-provider adapters (direct SDK access)
# gem 'dspy-openai'     # OpenAI, OpenRouter, Ollama
# gem 'dspy-anthropic'  # Claude
# gem 'dspy-gemini'     # Gemini
#
# # Observability (optional)
# gem 'dspy-o11y'
# gem 'dspy-o11y-langfuse'
#
# # Optimization (optional)
# gem 'dspy-miprov2'    # MIPROv2 optimizer
# gem 'dspy-gepa'       # GEPA optimizer
#
# # Schema formats (optional)
# gem 'sorbet-baml'     # BAML schema format (84% token reduction)

# =============================================================================
# Rails Initializer — config/initializers/dspy.rb
# =============================================================================

Rails.application.config.after_initialize do
  # Skip in test unless explicitly enabled
  next if Rails.env.test? && ENV["DSPY_ENABLE_IN_TEST"].blank?

  # Configure RubyLLM provider credentials
  RubyLLM.configure do |config|
    config.gemini_api_key = ENV["GEMINI_API_KEY"] if ENV["GEMINI_API_KEY"].present?
    config.anthropic_api_key = ENV["ANTHROPIC_API_KEY"] if ENV["ANTHROPIC_API_KEY"].present?
    config.openai_api_key = ENV["OPENAI_API_KEY"] if ENV["OPENAI_API_KEY"].present?
  end

  # Configure DSPy with unified RubyLLM adapter
  model = ENV.fetch("DSPY_MODEL", "ruby_llm/gemini-2.5-flash")
  DSPy.configure do |config|
    config.lm = DSPy::LM.new(model, structured_outputs: true)
    config.logger = Rails.logger
  end

  # Enable Langfuse observability (optional)
  if ENV["LANGFUSE_PUBLIC_KEY"].present? && ENV["LANGFUSE_SECRET_KEY"].present?
    DSPy::Observability.configure!
  end
end

# =============================================================================
# Feature Flags — config/initializers/feature_flags.rb
# =============================================================================

# Use different models for different roles:
#   - Fast/cheap for classification, routing, simple tasks
#   - Powerful for synthesis, reasoning, complex analysis

module FeatureFlags
  SELECTOR_MODEL = ENV.fetch("DSPY_SELECTOR_MODEL", "ruby_llm/gemini-2.5-flash-lite")
  SYNTHESIZER_MODEL = ENV.fetch("DSPY_SYNTHESIZER_MODEL", "ruby_llm/gemini-2.5-flash")
  REASONING_MODEL = ENV.fetch("DSPY_REASONING_MODEL", "ruby_llm/claude-sonnet-4-20250514")
end

# Usage in tools/modules:
#
#   class ClassifyTool < DSPy::Tools::Base
#     def call(query:)
#       predictor = DSPy::Predict.new(ClassifySignature)
#       predictor.configure { |c| c.lm = DSPy::LM.new(FeatureFlags::SELECTOR_MODEL, structured_outputs: true) }
#       predictor.call(query: query)
#     end
#   end

# =============================================================================
# Environment Variables — .env
# =============================================================================
#
# # Provider API keys (set the ones you need)
# GEMINI_API_KEY=...
# ANTHROPIC_API_KEY=...
# OPENAI_API_KEY=...
#
# # DSPy model configuration
# DSPY_MODEL=ruby_llm/gemini-2.5-flash
# DSPY_SELECTOR_MODEL=ruby_llm/gemini-2.5-flash-lite
# DSPY_SYNTHESIZER_MODEL=ruby_llm/gemini-2.5-flash
# DSPY_REASONING_MODEL=ruby_llm/claude-sonnet-4-20250514
#
# # Langfuse observability (optional)
# LANGFUSE_PUBLIC_KEY=pk-...
# LANGFUSE_SECRET_KEY=sk-...
# DSPY_TELEMETRY_BATCH_SIZE=5
#
# # Test environment
# DSPY_ENABLE_IN_TEST=1  # Set to enable DSPy in test env

# =============================================================================
# Per-Provider Configuration (without RubyLLM)
# =============================================================================

# OpenAI (dspy-openai gem)
# DSPy.configure do |c|
#   c.lm = DSPy::LM.new('openai/gpt-4o-mini', api_key: ENV['OPENAI_API_KEY'])
# end

# Anthropic (dspy-anthropic gem)
# DSPy.configure do |c|
#   c.lm = DSPy::LM.new('anthropic/claude-sonnet-4-20250514', api_key: ENV['ANTHROPIC_API_KEY'])
# end

# Gemini (dspy-gemini gem)
# DSPy.configure do |c|
#   c.lm = DSPy::LM.new('gemini/gemini-2.5-flash', api_key: ENV['GEMINI_API_KEY'])
# end

# Ollama (dspy-openai gem, local models)
# DSPy.configure do |c|
#   c.lm = DSPy::LM.new('ollama/llama3.2', base_url: 'http://localhost:11434')
# end

# OpenRouter (dspy-openai gem, 200+ models)
# DSPy.configure do |c|
#   c.lm = DSPy::LM.new('openrouter/anthropic/claude-3.5-sonnet',
#     api_key: ENV['OPENROUTER_API_KEY'],
#     base_url: 'https://openrouter.ai/api/v1')
# end

# =============================================================================
# VCR Test Configuration — spec/support/dspy.rb
# =============================================================================

# VCR.configure do |config|
#   config.cassette_library_dir = "spec/vcr_cassettes"
#   config.hook_into :webmock
#   config.configure_rspec_metadata!
#   config.filter_sensitive_data('<GEMINI_API_KEY>') { ENV['GEMINI_API_KEY'] }
#   config.filter_sensitive_data('<OPENAI_API_KEY>') { ENV['OPENAI_API_KEY'] }
#   config.filter_sensitive_data('<ANTHROPIC_API_KEY>') { ENV['ANTHROPIC_API_KEY'] }
# end

# =============================================================================
# Schema Format Configuration (optional)
# =============================================================================

# BAML schema format — 84% token reduction for Enhanced Prompting mode
# DSPy.configure do |c|
#   c.lm = DSPy::LM.new('openai/gpt-4o-mini',
#     api_key: ENV['OPENAI_API_KEY'],
#     schema_format: :baml  # Requires sorbet-baml gem
#   )
# end

# TOON schema + data format — table-oriented format
# DSPy.configure do |c|
#   c.lm = DSPy::LM.new('openai/gpt-4o-mini',
#     api_key: ENV['OPENAI_API_KEY'],
#     schema_format: :toon,  # How DSPy describes the signature
#     data_format: :toon     # How inputs/outputs are rendered in prompts
#   )
# end
#
# Note: BAML and TOON apply only when structured_outputs: false.
# With structured_outputs: true, the provider receives JSON Schema directly.
