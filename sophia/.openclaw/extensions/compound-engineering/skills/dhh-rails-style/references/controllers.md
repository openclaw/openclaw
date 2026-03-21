# Controllers - DHH Rails Style

<rest_mapping>
## Everything Maps to CRUD

Custom actions become new resources. Instead of verbs on existing resources, create noun resources:

```ruby
# Instead of this:
POST /cards/:id/close
DELETE /cards/:id/close
POST /cards/:id/archive

# Do this:
POST /cards/:id/closure      # create closure
DELETE /cards/:id/closure    # destroy closure
POST /cards/:id/archival     # create archival
```

**Real examples from 37signals:**
```ruby
resources :cards do
  resource :closure       # closing/reopening
  resource :goldness      # marking important
  resource :not_now       # postponing
  resources :assignments  # managing assignees
end
```

Each resource gets its own controller with standard CRUD actions.
</rest_mapping>

<controller_concerns>
## Concerns for Shared Behavior

Controllers use concerns extensively. Common patterns:

**CardScoped** - loads @card, @board, provides render_card_replacement
```ruby
module CardScoped
  extend ActiveSupport::Concern

  included do
    before_action :set_card
  end

  private
    def set_card
      @card = Card.find(params[:card_id])
      @board = @card.board
    end

    def render_card_replacement
      render turbo_stream: turbo_stream.replace(@card)
    end
end
```

**BoardScoped** - loads @board
**CurrentRequest** - populates Current with request data
**CurrentTimezone** - wraps requests in user's timezone
**FilterScoped** - handles complex filtering
**TurboFlash** - flash messages via Turbo Stream
**ViewTransitions** - disables on page refresh
**BlockSearchEngineIndexing** - sets X-Robots-Tag header
**RequestForgeryProtection** - Sec-Fetch-Site CSRF (modern browsers)
</controller_concerns>

<authorization_patterns>
## Authorization Patterns

Controllers check permissions via before_action, models define what permissions mean:

```ruby
# Controller concern
module Authorization
  extend ActiveSupport::Concern

  private
    def ensure_can_administer
      head :forbidden unless Current.user.admin?
    end

    def ensure_is_staff_member
      head :forbidden unless Current.user.staff?
    end
end

# Usage
class BoardsController < ApplicationController
  before_action :ensure_can_administer, only: [:destroy]
end
```

**Model-level authorization:**
```ruby
class Board < ApplicationRecord
  def editable_by?(user)
    user.admin? || user == creator
  end

  def publishable_by?(user)
    editable_by?(user) && !published?
  end
end
```

Keep authorization simple, readable, colocated with domain.
</authorization_patterns>

<security_concerns>
## Security Concerns

**Sec-Fetch-Site CSRF Protection:**
Modern browsers send Sec-Fetch-Site header. Use it for defense in depth:

```ruby
module RequestForgeryProtection
  extend ActiveSupport::Concern

  included do
    before_action :verify_request_origin
  end

  private
    def verify_request_origin
      return if request.get? || request.head?
      return if %w[same-origin same-site].include?(
        request.headers["Sec-Fetch-Site"]&.downcase
      )
      # Fall back to token verification for older browsers
      verify_authenticity_token
    end
end
```

**Rate Limiting (Rails 8+):**
```ruby
class MagicLinksController < ApplicationController
  rate_limit to: 10, within: 15.minutes, only: :create
end
```

Apply to: auth endpoints, email sending, external API calls, resource creation.
</security_concerns>

<request_context>
## Request Context Concerns

**CurrentRequest** - populates Current with HTTP metadata:
```ruby
module CurrentRequest
  extend ActiveSupport::Concern

  included do
    before_action :set_current_request
  end

  private
    def set_current_request
      Current.request_id = request.request_id
      Current.user_agent = request.user_agent
      Current.ip_address = request.remote_ip
      Current.referrer = request.referrer
    end
end
```

**CurrentTimezone** - wraps requests in user's timezone:
```ruby
module CurrentTimezone
  extend ActiveSupport::Concern

  included do
    around_action :set_timezone
    helper_method :timezone_from_cookie
  end

  private
    def set_timezone
      Time.use_zone(timezone_from_cookie) { yield }
    end

    def timezone_from_cookie
      cookies[:timezone] || "UTC"
    end
end
```

**SetPlatform** - detects mobile/desktop:
```ruby
module SetPlatform
  extend ActiveSupport::Concern

  included do
    helper_method :platform
  end

  def platform
    @platform ||= request.user_agent&.match?(/Mobile|Android/) ? :mobile : :desktop
  end
end
```
</request_context>

<turbo_responses>
## Turbo Stream Responses

Use Turbo Streams for partial updates:

```ruby
class Cards::ClosuresController < ApplicationController
  include CardScoped

  def create
    @card.close
    render_card_replacement
  end

  def destroy
    @card.reopen
    render_card_replacement
  end
end
```

For complex updates, use morphing:
```ruby
render turbo_stream: turbo_stream.morph(@card)
```
</turbo_responses>

<api_patterns>
## API Design

Same controllers, different format. Convention for responses:

```ruby
def create
  @card = Card.create!(card_params)

  respond_to do |format|
    format.html { redirect_to @card }
    format.json { head :created, location: @card }
  end
end

def update
  @card.update!(card_params)

  respond_to do |format|
    format.html { redirect_to @card }
    format.json { head :no_content }
  end
end

def destroy
  @card.destroy

  respond_to do |format|
    format.html { redirect_to cards_path }
    format.json { head :no_content }
  end
end
```

**Status codes:**
- Create: 201 Created + Location header
- Update: 204 No Content
- Delete: 204 No Content
- Bearer token authentication
</api_patterns>

<http_caching>
## HTTP Caching

Extensive use of ETags and conditional GETs:

```ruby
class CardsController < ApplicationController
  def show
    @card = Card.find(params[:id])
    fresh_when etag: [@card, Current.user.timezone]
  end

  def index
    @cards = @board.cards.preloaded
    fresh_when etag: [@cards, @board.updated_at]
  end
end
```

Key insight: Times render server-side in user's timezone, so timezone must affect the ETag to prevent serving wrong times to other timezones.

**ApplicationController global etag:**
```ruby
class ApplicationController < ActionController::Base
  etag { "v1" }  # Bump to invalidate all caches
end
```

Use `touch: true` on associations for cache invalidation.
</http_caching>
