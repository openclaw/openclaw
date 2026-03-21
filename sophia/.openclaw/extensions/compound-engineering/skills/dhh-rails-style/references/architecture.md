# Architecture - DHH Rails Style

<routing>
## Routing

Everything maps to CRUD. Nested resources for related actions:

```ruby
Rails.application.routes.draw do
  resources :boards do
    resources :cards do
      resource :closure
      resource :goldness
      resource :not_now
      resources :assignments
      resources :comments
    end
  end
end
```

**Verb-to-noun conversion:**
| Action | Resource |
|--------|----------|
| close a card | `card.closure` |
| watch a board | `board.watching` |
| mark as golden | `card.goldness` |
| archive a card | `card.archival` |

**Shallow nesting** - avoid deep URLs:
```ruby
resources :boards do
  resources :cards, shallow: true  # /boards/:id/cards, but /cards/:id
end
```

**Singular resources** for one-per-parent:
```ruby
resource :closure   # not resources
resource :goldness
```

**Resolve for URL generation:**
```ruby
# config/routes.rb
resolve("Comment") { |comment| [comment.card, anchor: dom_id(comment)] }

# Now url_for(@comment) works correctly
```
</routing>

<multi_tenancy>
## Multi-Tenancy (Path-Based)

**Middleware extracts tenant** from URL prefix:

```ruby
# lib/tenant_extractor.rb
class TenantExtractor
  def initialize(app)
    @app = app
  end

  def call(env)
    path = env["PATH_INFO"]
    if match = path.match(%r{^/(\d+)(/.*)?$})
      env["SCRIPT_NAME"] = "/#{match[1]}"
      env["PATH_INFO"] = match[2] || "/"
    end
    @app.call(env)
  end
end
```

**Cookie scoping** per tenant:
```ruby
# Cookies scoped to tenant path
cookies.signed[:session_id] = {
  value: session.id,
  path: "/#{Current.account.id}"
}
```

**Background job context** - serialize tenant:
```ruby
class ApplicationJob < ActiveJob::Base
  around_perform do |job, block|
    Current.set(account: job.arguments.first.account) { block.call }
  end
end
```

**Recurring jobs** must iterate all tenants:
```ruby
class DailyDigestJob < ApplicationJob
  def perform
    Account.find_each do |account|
      Current.set(account: account) do
        send_digest_for(account)
      end
    end
  end
end
```

**Controller security** - always scope through tenant:
```ruby
# Good - scoped through user's accessible records
@card = Current.user.accessible_cards.find(params[:id])

# Avoid - direct lookup
@card = Card.find(params[:id])
```
</multi_tenancy>

<authentication>
## Authentication

Custom passwordless magic link auth (~150 lines total):

```ruby
# app/models/session.rb
class Session < ApplicationRecord
  belongs_to :user

  before_create { self.token = SecureRandom.urlsafe_base64(32) }
end

# app/models/magic_link.rb
class MagicLink < ApplicationRecord
  belongs_to :user

  before_create do
    self.code = SecureRandom.random_number(100_000..999_999).to_s
    self.expires_at = 15.minutes.from_now
  end

  def expired?
    expires_at < Time.current
  end
end
```

**Why not Devise:**
- ~150 lines vs massive dependency
- No password storage liability
- Simpler UX for users
- Full control over flow

**Bearer token** for APIs:
```ruby
module Authentication
  extend ActiveSupport::Concern

  included do
    before_action :authenticate
  end

  private
    def authenticate
      if bearer_token = request.headers["Authorization"]&.split(" ")&.last
        Current.session = Session.find_by(token: bearer_token)
      else
        Current.session = Session.find_by(id: cookies.signed[:session_id])
      end

      redirect_to login_path unless Current.session
    end
end
```
</authentication>

<background_jobs>
## Background Jobs

Jobs are shallow wrappers calling model methods:

```ruby
class NotifyWatchersJob < ApplicationJob
  def perform(card)
    card.notify_watchers
  end
end
```

**Naming convention:**
- `_later` suffix for async: `card.notify_watchers_later`
- `_now` suffix for immediate: `card.notify_watchers_now`

```ruby
module Watchable
  def notify_watchers_later
    NotifyWatchersJob.perform_later(self)
  end

  def notify_watchers_now
    NotifyWatchersJob.perform_now(self)
  end

  def notify_watchers
    watchers.each do |watcher|
      WatcherMailer.notification(watcher, self).deliver_later
    end
  end
end
```

**Database-backed** with Solid Queue:
- No Redis required
- Same transactional guarantees as your data
- Simpler infrastructure

**Transaction safety:**
```ruby
# config/application.rb
config.active_job.enqueue_after_transaction_commit = true
```

**Error handling** by type:
```ruby
class DeliveryJob < ApplicationJob
  # Transient errors - retry with backoff
  retry_on Net::OpenTimeout, Net::ReadTimeout,
           Resolv::ResolvError,
           wait: :polynomially_longer

  # Permanent errors - log and discard
  discard_on Net::SMTPSyntaxError do |job, error|
    Sentry.capture_exception(error, level: :info)
  end
end
```

**Batch processing** with continuable:
```ruby
class ProcessCardsJob < ApplicationJob
  include ActiveJob::Continuable

  def perform
    Card.in_batches.each_record do |card|
      checkpoint!  # Resume from here if interrupted
      process(card)
    end
  end
end
```
</background_jobs>

<database_patterns>
## Database Patterns

**UUIDs as primary keys** (time-sortable UUIDv7):
```ruby
# migration
create_table :cards, id: :uuid do |t|
  t.references :board, type: :uuid, foreign_key: true
end
```

Benefits: No ID enumeration, distributed-friendly, client-side generation.

**State as records** (not booleans):
```ruby
# Instead of closed: boolean
class Card::Closure < ApplicationRecord
  belongs_to :card
  belongs_to :creator, class_name: "User"
end

# Queries become joins
Card.joins(:closure)          # closed
Card.where.missing(:closure)  # open
```

**Hard deletes** - no soft delete:
```ruby
# Just destroy
card.destroy!

# Use events for history
card.record_event(:deleted, by: Current.user)
```

Simplifies queries, uses event logs for auditing.

**Counter caches** for performance:
```ruby
class Comment < ApplicationRecord
  belongs_to :card, counter_cache: true
end

# card.comments_count available without query
```

**Account scoping** on every table:
```ruby
class Card < ApplicationRecord
  belongs_to :account
  default_scope { where(account: Current.account) }
end
```
</database_patterns>

<current_attributes>
## Current Attributes

Use `Current` for request-scoped state:

```ruby
# app/models/current.rb
class Current < ActiveSupport::CurrentAttributes
  attribute :session, :user, :account, :request_id

  delegate :user, to: :session, allow_nil: true

  def account=(account)
    super
    Time.zone = account&.time_zone || "UTC"
  end
end
```

Set in controller:
```ruby
class ApplicationController < ActionController::Base
  before_action :set_current_request

  private
    def set_current_request
      Current.session = authenticated_session
      Current.account = Account.find(params[:account_id])
      Current.request_id = request.request_id
    end
end
```

Use throughout app:
```ruby
class Card < ApplicationRecord
  belongs_to :creator, default: -> { Current.user }
end
```
</current_attributes>

<caching>
## Caching

**HTTP caching** with ETags:
```ruby
fresh_when etag: [@card, Current.user.timezone]
```

**Fragment caching:**
```erb
<% cache card do %>
  <%= render card %>
<% end %>
```

**Russian doll caching:**
```erb
<% cache @board do %>
  <% @board.cards.each do |card| %>
    <% cache card do %>
      <%= render card %>
    <% end %>
  <% end %>
<% end %>
```

**Cache invalidation** via `touch: true`:
```ruby
class Card < ApplicationRecord
  belongs_to :board, touch: true
end
```

**Solid Cache** - database-backed:
- No Redis required
- Consistent with application data
- Simpler infrastructure
</caching>

<configuration>
## Configuration

**ENV.fetch with defaults:**
```ruby
# config/application.rb
config.active_job.queue_adapter = ENV.fetch("QUEUE_ADAPTER", "solid_queue").to_sym
config.cache_store = ENV.fetch("CACHE_STORE", "solid_cache").to_sym
```

**Multiple databases:**
```yaml
# config/database.yml
production:
  primary:
    <<: *default
  cable:
    <<: *default
    migrations_paths: db/cable_migrate
  queue:
    <<: *default
    migrations_paths: db/queue_migrate
  cache:
    <<: *default
    migrations_paths: db/cache_migrate
```

**Switch between SQLite and MySQL via ENV:**
```ruby
adapter = ENV.fetch("DATABASE_ADAPTER", "sqlite3")
```

**CSP extensible via ENV:**
```ruby
config.content_security_policy do |policy|
  policy.default_src :self
  policy.script_src :self, *ENV.fetch("CSP_SCRIPT_SRC", "").split(",")
end
```
</configuration>

<testing>
## Testing

**Minitest**, not RSpec:
```ruby
class CardTest < ActiveSupport::TestCase
  test "closing a card creates a closure" do
    card = cards(:one)

    card.close

    assert card.closed?
    assert_not_nil card.closure
  end
end
```

**Fixtures** instead of factories:
```yaml
# test/fixtures/cards.yml
one:
  title: First Card
  board: main
  creator: alice

two:
  title: Second Card
  board: main
  creator: bob
```

**Integration tests** for controllers:
```ruby
class CardsControllerTest < ActionDispatch::IntegrationTest
  test "closing a card" do
    card = cards(:one)
    sign_in users(:alice)

    post card_closure_path(card)

    assert_response :success
    assert card.reload.closed?
  end
end
```

**Tests ship with features** - same commit, not TDD-first but together.

**Regression tests for security fixes** - always.
</testing>

<events>
## Event Tracking

Events are the single source of truth:

```ruby
class Event < ApplicationRecord
  belongs_to :creator, class_name: "User"
  belongs_to :eventable, polymorphic: true

  serialize :particulars, coder: JSON
end
```

**Eventable concern:**
```ruby
module Eventable
  extend ActiveSupport::Concern

  included do
    has_many :events, as: :eventable, dependent: :destroy
  end

  def record_event(action, particulars = {})
    events.create!(
      creator: Current.user,
      action: action,
      particulars: particulars
    )
  end
end
```

**Webhooks driven by events** - events are the canonical source.
</events>

<email_patterns>
## Email Patterns

**Multi-tenant URL helpers:**
```ruby
class ApplicationMailer < ActionMailer::Base
  def default_url_options
    options = super
    if Current.account
      options[:script_name] = "/#{Current.account.id}"
    end
    options
  end
end
```

**Timezone-aware delivery:**
```ruby
class NotificationMailer < ApplicationMailer
  def daily_digest(user)
    Time.use_zone(user.timezone) do
      @user = user
      @digest = user.digest_for_today
      mail(to: user.email, subject: "Daily Digest")
    end
  end
end
```

**Batch delivery:**
```ruby
emails = users.map { |user| NotificationMailer.digest(user) }
ActiveJob.perform_all_later(emails.map(&:deliver_later))
```

**One-click unsubscribe (RFC 8058):**
```ruby
class ApplicationMailer < ActionMailer::Base
  after_action :set_unsubscribe_headers

  private
    def set_unsubscribe_headers
      headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
      headers["List-Unsubscribe"] = "<#{unsubscribe_url}>"
    end
end
```
</email_patterns>

<security_patterns>
## Security Patterns

**XSS prevention** - escape in helpers:
```ruby
def formatted_content(text)
  # Escape first, then mark safe
  simple_format(h(text)).html_safe
end
```

**SSRF protection:**
```ruby
# Resolve DNS once, pin the IP
def fetch_safely(url)
  uri = URI.parse(url)
  ip = Resolv.getaddress(uri.host)

  # Block private networks
  raise "Private IP" if private_ip?(ip)

  # Use pinned IP for request
  Net::HTTP.start(uri.host, uri.port, ipaddr: ip) { |http| ... }
end

def private_ip?(ip)
  ip.start_with?("127.", "10.", "192.168.") ||
    ip.match?(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)
end
```

**Content Security Policy:**
```ruby
# config/initializers/content_security_policy.rb
Rails.application.configure do
  config.content_security_policy do |policy|
    policy.default_src :self
    policy.script_src :self
    policy.style_src :self, :unsafe_inline
    policy.base_uri :none
    policy.form_action :self
    policy.frame_ancestors :self
  end
end
```

**ActionText sanitization:**
```ruby
# config/initializers/action_text.rb
Rails.application.config.after_initialize do
  ActionText::ContentHelper.allowed_tags = %w[
    strong em a ul ol li p br h1 h2 h3 h4 blockquote
  ]
end
```
</security_patterns>

<active_storage>
## Active Storage Patterns

**Variant preprocessing:**
```ruby
class User < ApplicationRecord
  has_one_attached :avatar do |attachable|
    attachable.variant :thumb, resize_to_limit: [100, 100], preprocessed: true
    attachable.variant :medium, resize_to_limit: [300, 300], preprocessed: true
  end
end
```

**Direct upload expiry** - extend for slow connections:
```ruby
# config/initializers/active_storage.rb
Rails.application.config.active_storage.service_urls_expire_in = 48.hours
```

**Avatar optimization** - redirect to blob:
```ruby
def show
  expires_in 1.year, public: true
  redirect_to @user.avatar.variant(:thumb).processed.url, allow_other_host: true
end
```

**Mirror service** for migrations:
```yaml
# config/storage.yml
production:
  service: Mirror
  primary: amazon
  mirrors: [google]
```
</active_storage>
