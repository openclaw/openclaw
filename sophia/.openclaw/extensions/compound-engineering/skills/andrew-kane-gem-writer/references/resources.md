# Andrew Kane Resources

## Primary Documentation

- **Gem Patterns Article**: https://ankane.org/gem-patterns
  - Kane's own documentation of patterns used across his gems
  - Covers configuration, Rails integration, error handling

## Top Ruby Gems by Stars

### Search & Data

| Gem | Stars | Description | Source |
|-----|-------|-------------|--------|
| **Searchkick** | 6.6k+ | Intelligent search for Rails | https://github.com/ankane/searchkick |
| **Chartkick** | 6.4k+ | Beautiful charts in Ruby | https://github.com/ankane/chartkick |
| **Groupdate** | 3.8k+ | Group by day, week, month | https://github.com/ankane/groupdate |
| **Blazer** | 4.6k+ | SQL dashboard for Rails | https://github.com/ankane/blazer |

### Database & Migrations

| Gem | Stars | Description | Source |
|-----|-------|-------------|--------|
| **PgHero** | 8.2k+ | PostgreSQL insights | https://github.com/ankane/pghero |
| **Strong Migrations** | 4.1k+ | Safe migration checks | https://github.com/ankane/strong_migrations |
| **Dexter** | 1.8k+ | Auto index advisor | https://github.com/ankane/dexter |
| **PgSync** | 1.5k+ | Sync Postgres data | https://github.com/ankane/pgsync |

### Security & Encryption

| Gem | Stars | Description | Source |
|-----|-------|-------------|--------|
| **Lockbox** | 1.5k+ | Application-level encryption | https://github.com/ankane/lockbox |
| **Blind Index** | 1.0k+ | Encrypted search | https://github.com/ankane/blind_index |
| **Secure Headers** | — | Contributed patterns | Referenced in gems |

### Analytics & ML

| Gem | Stars | Description | Source |
|-----|-------|-------------|--------|
| **Ahoy** | 4.2k+ | Analytics for Rails | https://github.com/ankane/ahoy |
| **Neighbor** | 1.1k+ | Vector search for Rails | https://github.com/ankane/neighbor |
| **Rover** | 700+ | DataFrames for Ruby | https://github.com/ankane/rover |
| **Tomoto** | 200+ | Topic modeling | https://github.com/ankane/tomoto-ruby |

### Utilities

| Gem | Stars | Description | Source |
|-----|-------|-------------|--------|
| **Pretender** | 2.0k+ | Login as another user | https://github.com/ankane/pretender |
| **Authtrail** | 900+ | Login activity tracking | https://github.com/ankane/authtrail |
| **Notable** | 200+ | Track notable requests | https://github.com/ankane/notable |
| **Logstop** | 200+ | Filter sensitive logs | https://github.com/ankane/logstop |

## Key Source Files to Study

### Entry Point Patterns
- https://github.com/ankane/searchkick/blob/master/lib/searchkick.rb
- https://github.com/ankane/pghero/blob/master/lib/pghero.rb
- https://github.com/ankane/strong_migrations/blob/master/lib/strong_migrations.rb
- https://github.com/ankane/lockbox/blob/master/lib/lockbox.rb

### Class Macro Implementations
- https://github.com/ankane/searchkick/blob/master/lib/searchkick/model.rb
- https://github.com/ankane/lockbox/blob/master/lib/lockbox/model.rb
- https://github.com/ankane/neighbor/blob/master/lib/neighbor/model.rb
- https://github.com/ankane/blind_index/blob/master/lib/blind_index/model.rb

### Rails Integration (Railtie/Engine)
- https://github.com/ankane/pghero/blob/master/lib/pghero/engine.rb
- https://github.com/ankane/searchkick/blob/master/lib/searchkick/railtie.rb
- https://github.com/ankane/ahoy/blob/master/lib/ahoy/engine.rb
- https://github.com/ankane/blazer/blob/master/lib/blazer/engine.rb

### Database Adapters
- https://github.com/ankane/strong_migrations/tree/master/lib/strong_migrations/adapters
- https://github.com/ankane/groupdate/tree/master/lib/groupdate/adapters
- https://github.com/ankane/neighbor/tree/master/lib/neighbor

### Error Messages (Template Pattern)
- https://github.com/ankane/strong_migrations/blob/master/lib/strong_migrations/error_messages.rb

### Gemspec Examples
- https://github.com/ankane/searchkick/blob/master/searchkick.gemspec
- https://github.com/ankane/neighbor/blob/master/neighbor.gemspec
- https://github.com/ankane/ahoy/blob/master/ahoy_matey.gemspec

### Test Setups
- https://github.com/ankane/searchkick/tree/master/test
- https://github.com/ankane/lockbox/tree/master/test
- https://github.com/ankane/strong_migrations/tree/master/test

## GitHub Profile

- **Profile**: https://github.com/ankane
- **All Ruby Repos**: https://github.com/ankane?tab=repositories&q=&type=&language=ruby&sort=stargazers
- **RubyGems Profile**: https://rubygems.org/profiles/ankane

## Blog Posts & Articles

- **ankane.org**: https://ankane.org/
- **Gem Patterns**: https://ankane.org/gem-patterns (essential reading)
- **Postgres Performance**: https://ankane.org/introducing-pghero
- **Search Tips**: https://ankane.org/search-rails

## Design Philosophy Summary

From studying 100+ gems, Kane's consistent principles:

1. **Zero dependencies when possible** - Each dep is a maintenance burden
2. **ActiveSupport.on_load always** - Never require Rails gems directly
3. **Class macro DSLs** - Single method configures everything
4. **Explicit over magic** - No method_missing, define methods directly
5. **Minitest only** - Simple, sufficient, no RSpec
6. **Multi-version testing** - Support broad Rails/Ruby versions
7. **Helpful errors** - Template-based messages with fix suggestions
8. **Abstract adapters** - Clean multi-database support
9. **Engine isolation** - isolate_namespace for mountable gems
10. **Minimal documentation** - Code is self-documenting, README is examples
