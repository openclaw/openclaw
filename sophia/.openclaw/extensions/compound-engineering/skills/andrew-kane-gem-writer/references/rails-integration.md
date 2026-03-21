# Rails Integration Patterns

## The Golden Rule

**Never require Rails gems directly.** This causes loading order issues.

```ruby
# WRONG - causes premature loading
require "active_record"
ActiveRecord::Base.include(MyGem::Model)

# CORRECT - lazy loading
ActiveSupport.on_load(:active_record) do
  extend MyGem::Model
end
```

## ActiveSupport.on_load Hooks

Common hooks and their uses:

```ruby
# Models
ActiveSupport.on_load(:active_record) do
  extend GemName::Model        # Add class methods (searchkick, has_encrypted)
  include GemName::Callbacks   # Add instance methods
end

# Controllers
ActiveSupport.on_load(:action_controller) do
  include Ahoy::Controller
end

# Jobs
ActiveSupport.on_load(:active_job) do
  include GemName::JobExtensions
end

# Mailers
ActiveSupport.on_load(:action_mailer) do
  include GemName::MailerExtensions
end
```

## Prepend for Behavior Modification

When overriding existing Rails methods:

```ruby
ActiveSupport.on_load(:active_record) do
  ActiveRecord::Migration.prepend(StrongMigrations::Migration)
  ActiveRecord::Migrator.prepend(StrongMigrations::Migrator)
end
```

## Railtie Pattern

Minimal Railtie for non-mountable gems:

```ruby
# lib/gemname/railtie.rb
module GemName
  class Railtie < Rails::Railtie
    initializer "gemname.configure" do
      ActiveSupport.on_load(:active_record) do
        extend GemName::Model
      end
    end

    # Optional: Add to controller runtime logging
    initializer "gemname.log_runtime" do
      require_relative "controller_runtime"
      ActiveSupport.on_load(:action_controller) do
        include GemName::ControllerRuntime
      end
    end

    # Optional: Rake tasks
    rake_tasks do
      load "tasks/gemname.rake"
    end
  end
end
```

## Engine Pattern (Mountable Gems)

For gems with web interfaces (PgHero, Blazer, Ahoy):

```ruby
# lib/pghero/engine.rb
module PgHero
  class Engine < ::Rails::Engine
    isolate_namespace PgHero

    initializer "pghero.assets", group: :all do |app|
      if app.config.respond_to?(:assets) && defined?(Sprockets)
        app.config.assets.precompile << "pghero/application.js"
        app.config.assets.precompile << "pghero/application.css"
      end
    end

    initializer "pghero.config" do
      PgHero.config = Rails.application.config_for(:pghero) rescue {}
    end
  end
end
```

## Routes for Engines

```ruby
# config/routes.rb (in engine)
PgHero::Engine.routes.draw do
  root to: "home#index"
  resources :databases, only: [:show]
end
```

Mount in app:

```ruby
# config/routes.rb (in app)
mount PgHero::Engine, at: "pghero"
```

## YAML Configuration with ERB

For complex gems needing config files:

```ruby
def self.settings
  @settings ||= begin
    path = Rails.root.join("config", "blazer.yml")
    if path.exist?
      YAML.safe_load(ERB.new(File.read(path)).result, aliases: true)
    else
      {}
    end
  end
end
```

## Generator Pattern

```ruby
# lib/generators/gemname/install_generator.rb
module GemName
  module Generators
    class InstallGenerator < Rails::Generators::Base
      source_root File.expand_path("templates", __dir__)

      def copy_initializer
        template "initializer.rb", "config/initializers/gemname.rb"
      end

      def copy_migration
        migration_template "migration.rb", "db/migrate/create_gemname_tables.rb"
      end
    end
  end
end
```

## Conditional Feature Detection

```ruby
# Check for specific Rails versions
if ActiveRecord.version >= Gem::Version.new("7.0")
  # Rails 7+ specific code
end

# Check for optional dependencies
def self.client
  @client ||= if defined?(OpenSearch::Client)
    OpenSearch::Client.new
  elsif defined?(Elasticsearch::Client)
    Elasticsearch::Client.new
  else
    raise Error, "Install elasticsearch or opensearch-ruby"
  end
end
```
