# Gems - DHH Rails Style

<what_they_use>
## What 37signals Uses

**Core Rails stack:**
- turbo-rails, stimulus-rails, importmap-rails
- propshaft (asset pipeline)

**Database-backed services (Solid suite):**
- solid_queue - background jobs
- solid_cache - caching
- solid_cable - WebSockets/Action Cable

**Authentication & Security:**
- bcrypt (for any password hashing needed)

**Their own gems:**
- geared_pagination (cursor-based pagination)
- lexxy (rich text editor)
- mittens (mailer utilities)

**Utilities:**
- rqrcode (QR code generation)
- redcarpet + rouge (Markdown rendering)
- web-push (push notifications)

**Deployment & Operations:**
- kamal (Docker deployment)
- thruster (HTTP/2 proxy)
- mission_control-jobs (job monitoring)
- autotuner (GC tuning)
</what_they_use>

<what_they_avoid>
## What They Deliberately Avoid

**Authentication:**
```
devise → Custom ~150-line auth
```
Why: Full control, no password liability with magic links, simpler.

**Authorization:**
```
pundit/cancancan → Simple role checks in models
```
Why: Most apps don't need policy objects. A method on the model suffices:
```ruby
class Board < ApplicationRecord
  def editable_by?(user)
    user.admin? || user == creator
  end
end
```

**Background Jobs:**
```
sidekiq → Solid Queue
```
Why: Database-backed means no Redis, same transactional guarantees.

**Caching:**
```
redis → Solid Cache
```
Why: Database is already there, simpler infrastructure.

**Search:**
```
elasticsearch → Custom sharded search
```
Why: Built exactly what they need, no external service dependency.

**View Layer:**
```
view_component → Standard partials
```
Why: Partials work fine. ViewComponents add complexity without clear benefit for their use case.

**API:**
```
GraphQL → REST with Turbo
```
Why: REST is sufficient when you control both ends. GraphQL complexity not justified.

**Factories:**
```
factory_bot → Fixtures
```
Why: Fixtures are simpler, faster, and encourage thinking about data relationships upfront.

**Service Objects:**
```
Interactor, Trailblazer → Fat models
```
Why: Business logic stays in models. Methods like `card.close` instead of `CardCloser.call(card)`.

**Form Objects:**
```
Reform, dry-validation → params.expect + model validations
```
Why: Rails 7.1's `params.expect` is clean enough. Contextual validations on model.

**Decorators:**
```
Draper → View helpers + partials
```
Why: Helpers and partials are simpler. No decorator indirection.

**CSS:**
```
Tailwind, Sass → Native CSS
```
Why: Modern CSS has nesting, variables, layers. No build step needed.

**Frontend:**
```
React, Vue, SPAs → Turbo + Stimulus
```
Why: Server-rendered HTML with sprinkles of JS. SPA complexity not justified.

**Testing:**
```
RSpec → Minitest
```
Why: Simpler, faster boot, less DSL magic, ships with Rails.
</what_they_avoid>

<testing_philosophy>
## Testing Philosophy

**Minitest** - simpler, faster:
```ruby
class CardTest < ActiveSupport::TestCase
  test "closing creates closure" do
    card = cards(:one)
    assert_difference -> { Card::Closure.count } do
      card.close
    end
    assert card.closed?
  end
end
```

**Fixtures** - loaded once, deterministic:
```yaml
# test/fixtures/cards.yml
open_card:
  title: Open Card
  board: main
  creator: alice

closed_card:
  title: Closed Card
  board: main
  creator: bob
```

**Dynamic timestamps** with ERB:
```yaml
recent:
  title: Recent
  created_at: <%= 1.hour.ago %>

old:
  title: Old
  created_at: <%= 1.month.ago %>
```

**Time travel** for time-dependent tests:
```ruby
test "expires after 15 minutes" do
  magic_link = MagicLink.create!(user: users(:alice))

  travel 16.minutes

  assert magic_link.expired?
end
```

**VCR** for external APIs:
```ruby
VCR.use_cassette("stripe/charge") do
  charge = Stripe::Charge.create(amount: 1000)
  assert charge.paid
end
```

**Tests ship with features** - same commit, not before or after.
</testing_philosophy>

<decision_framework>
## Decision Framework

Before adding a gem, ask:

1. **Can vanilla Rails do this?**
   - ActiveRecord can do most things Sequel can
   - ActionMailer handles email fine
   - ActiveJob works for most job needs

2. **Is the complexity worth it?**
   - 150 lines of custom code vs. 10,000-line gem
   - You'll understand your code better
   - Fewer upgrade headaches

3. **Does it add infrastructure?**
   - Redis? Consider database-backed alternatives
   - External service? Consider building in-house
   - Simpler infrastructure = fewer failure modes

4. **Is it from someone you trust?**
   - 37signals gems: battle-tested at scale
   - Well-maintained, focused gems: usually fine
   - Kitchen-sink gems: probably overkill

**The philosophy:**
> "Build solutions before reaching for gems."

Not anti-gem, but pro-understanding. Use gems when they genuinely solve a problem you have, not a problem you might have.
</decision_framework>

<gem_patterns>
## Gem Usage Patterns

**Pagination:**
```ruby
# geared_pagination - cursor-based
class CardsController < ApplicationController
  def index
    @cards = @board.cards.geared(page: params[:page])
  end
end
```

**Markdown:**
```ruby
# redcarpet + rouge
class MarkdownRenderer
  def self.render(text)
    Redcarpet::Markdown.new(
      Redcarpet::Render::HTML.new(filter_html: true),
      autolink: true,
      fenced_code_blocks: true
    ).render(text)
  end
end
```

**Background jobs:**
```ruby
# solid_queue - no Redis
class ApplicationJob < ActiveJob::Base
  queue_as :default
  # Just works, backed by database
end
```

**Caching:**
```ruby
# solid_cache - no Redis
# config/environments/production.rb
config.cache_store = :solid_cache_store
```
</gem_patterns>
