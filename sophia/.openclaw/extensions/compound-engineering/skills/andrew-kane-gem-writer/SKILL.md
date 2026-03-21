---
name: andrew-kane-gem-writer
description: This skill should be used when writing Ruby gems following Andrew Kane's proven patterns and philosophy. It applies when creating new Ruby gems, refactoring existing gems, designing gem APIs, or when clean, minimal, production-ready Ruby library code is needed. Triggers on requests like "create a gem", "write a Ruby library", "design a gem API", or mentions of Andrew Kane's style.
---

# Andrew Kane Gem Writer

Write Ruby gems following Andrew Kane's battle-tested patterns from 100+ gems with 374M+ downloads (Searchkick, PgHero, Chartkick, Strong Migrations, Lockbox, Ahoy, Blazer, Groupdate, Neighbor, Blind Index).

## Core Philosophy

**Simplicity over cleverness.** Zero or minimal dependencies. Explicit code over metaprogramming. Rails integration without Rails coupling. Every pattern serves production use cases.

## Entry Point Structure

Every gem follows this exact pattern in `lib/gemname.rb`:

```ruby
# 1. Dependencies (stdlib preferred)
require "forwardable"

# 2. Internal modules
require_relative "gemname/model"
require_relative "gemname/version"

# 3. Conditional Rails (CRITICAL - never require Rails directly)
require_relative "gemname/railtie" if defined?(Rails)

# 4. Module with config and errors
module GemName
  class Error < StandardError; end
  class InvalidConfigError < Error; end

  class << self
    attr_accessor :timeout, :logger
    attr_writer :client
  end

  self.timeout = 10  # Defaults set immediately
end
```

## Class Macro DSL Pattern

The signature Kane pattern—single method call configures everything:

```ruby
# Usage
class Product < ApplicationRecord
  searchkick word_start: [:name]
end

# Implementation
module GemName
  module Model
    def gemname(**options)
      unknown = options.keys - KNOWN_KEYWORDS
      raise ArgumentError, "unknown keywords: #{unknown.join(", ")}" if unknown.any?

      mod = Module.new
      mod.module_eval do
        define_method :some_method do
          # implementation
        end unless method_defined?(:some_method)
      end
      include mod

      class_eval do
        cattr_reader :gemname_options, instance_reader: false
        class_variable_set :@@gemname_options, options.dup
      end
    end
  end
end
```

## Rails Integration

**Always use `ActiveSupport.on_load`—never require Rails gems directly:**

```ruby
# WRONG
require "active_record"
ActiveRecord::Base.include(MyGem::Model)

# CORRECT
ActiveSupport.on_load(:active_record) do
  extend GemName::Model
end

# Use prepend for behavior modification
ActiveSupport.on_load(:active_record) do
  ActiveRecord::Migration.prepend(GemName::Migration)
end
```

## Configuration Pattern

Use `class << self` with `attr_accessor`, not Configuration objects:

```ruby
module GemName
  class << self
    attr_accessor :timeout, :logger
    attr_writer :master_key
  end

  def self.master_key
    @master_key ||= ENV["GEMNAME_MASTER_KEY"]
  end

  self.timeout = 10
  self.logger = nil
end
```

## Error Handling

Simple hierarchy with informative messages:

```ruby
module GemName
  class Error < StandardError; end
  class ConfigError < Error; end
  class ValidationError < Error; end
end

# Validate early with ArgumentError
def initialize(key:)
  raise ArgumentError, "Key must be 32 bytes" unless key&.bytesize == 32
end
```

## Testing (Minitest Only)

```ruby
# test/test_helper.rb
require "bundler/setup"
Bundler.require(:default)
require "minitest/autorun"
require "minitest/pride"

# test/model_test.rb
class ModelTest < Minitest::Test
  def test_basic_functionality
    assert_equal expected, actual
  end
end
```

## Gemspec Pattern

Zero runtime dependencies when possible:

```ruby
Gem::Specification.new do |spec|
  spec.name = "gemname"
  spec.version = GemName::VERSION
  spec.required_ruby_version = ">= 3.1"
  spec.files = Dir["*.{md,txt}", "{lib}/**/*"]
  spec.require_path = "lib"
  # NO add_dependency lines - dev deps go in Gemfile
end
```

## Anti-Patterns to Avoid

- `method_missing` (use `define_method` instead)
- Configuration objects (use class accessors)
- `@@class_variables` (use `class << self`)
- Requiring Rails gems directly
- Many runtime dependencies
- Committing Gemfile.lock in gems
- RSpec (use Minitest)
- Heavy DSLs (prefer explicit Ruby)

## Reference Files

For deeper patterns, see:
- **[references/module-organization.md](references/module-organization.md)** - Directory layouts, method decomposition
- **[references/rails-integration.md](references/rails-integration.md)** - Railtie, Engine, on_load patterns
- **[references/database-adapters.md](references/database-adapters.md)** - Multi-database support patterns
- **[references/testing-patterns.md](references/testing-patterns.md)** - Multi-version testing, CI setup
- **[references/resources.md](references/resources.md)** - Links to Kane's repos and articles
