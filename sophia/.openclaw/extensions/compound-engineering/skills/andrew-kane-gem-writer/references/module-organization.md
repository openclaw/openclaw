# Module Organization Patterns

## Simple Gem Layout

```
lib/
├── gemname.rb          # Entry point, config, errors
└── gemname/
    ├── helper.rb       # Core functionality
    ├── engine.rb       # Rails engine (if needed)
    └── version.rb      # VERSION constant only
```

## Complex Gem Layout (PgHero pattern)

```
lib/
├── pghero.rb
└── pghero/
    ├── database.rb     # Main class
    ├── engine.rb       # Rails engine
    └── methods/        # Functional decomposition
        ├── basic.rb
        ├── connections.rb
        ├── indexes.rb
        ├── queries.rb
        └── replication.rb
```

## Method Decomposition Pattern

Break large classes into includable modules by feature:

```ruby
# lib/pghero/database.rb
module PgHero
  class Database
    include Methods::Basic
    include Methods::Connections
    include Methods::Indexes
    include Methods::Queries
  end
end

# lib/pghero/methods/indexes.rb
module PgHero
  module Methods
    module Indexes
      def index_hit_rate
        # implementation
      end

      def unused_indexes
        # implementation
      end
    end
  end
end
```

## Version File Pattern

Keep version.rb minimal:

```ruby
# lib/gemname/version.rb
module GemName
  VERSION = "2.0.0"
end
```

## Require Order in Entry Point

```ruby
# lib/searchkick.rb

# 1. Standard library
require "forwardable"
require "json"

# 2. External dependencies (minimal)
require "active_support"

# 3. Internal files via require_relative
require_relative "searchkick/index"
require_relative "searchkick/model"
require_relative "searchkick/query"
require_relative "searchkick/version"

# 4. Conditional Rails loading (LAST)
require_relative "searchkick/railtie" if defined?(Rails)
```

## Autoload vs Require

Kane uses explicit `require_relative`, not autoload:

```ruby
# CORRECT
require_relative "gemname/model"
require_relative "gemname/query"

# AVOID
autoload :Model, "gemname/model"
autoload :Query, "gemname/query"
```

## Comments Style

Minimal section headers only:

```ruby
# dependencies
require "active_support"

# adapters
require_relative "adapters/postgresql_adapter"

# modules
require_relative "migration"
```
