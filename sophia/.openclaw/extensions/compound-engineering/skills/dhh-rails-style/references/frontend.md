# Frontend - DHH Rails Style

<turbo_patterns>
## Turbo Patterns

**Turbo Streams** for partial updates:
```erb
<%# app/views/cards/closures/create.turbo_stream.erb %>
<%= turbo_stream.replace @card %>
```

**Morphing** for complex updates:
```ruby
render turbo_stream: turbo_stream.morph(@card)
```

**Global morphing** - enable in layout:
```ruby
turbo_refreshes_with method: :morph, scroll: :preserve
```

**Fragment caching** with `cached: true`:
```erb
<%= render partial: "card", collection: @cards, cached: true %>
```

**No ViewComponents** - standard partials work fine.
</turbo_patterns>

<turbo_morphing>
## Turbo Morphing Best Practices

**Listen for morph events** to restore client state:
```javascript
document.addEventListener("turbo:morph-element", (event) => {
  // Restore any client-side state after morph
})
```

**Permanent elements** - skip morphing with data attribute:
```erb
<div data-turbo-permanent id="notification-count">
  <%= @count %>
</div>
```

**Frame morphing** - add refresh attribute:
```erb
<%= turbo_frame_tag :assignment, src: path, refresh: :morph %>
```

**Common issues and solutions:**

| Problem | Solution |
|---------|----------|
| Timers not updating | Clear/restart in morph event listener |
| Forms resetting | Wrap form sections in turbo frames |
| Pagination breaking | Use turbo frames with `refresh: :morph` |
| Flickering on replace | Switch to morph instead of replace |
| localStorage loss | Listen to `turbo:morph-element`, restore state |
</turbo_morphing>

<turbo_frames>
## Turbo Frames

**Lazy loading** with spinner:
```erb
<%= turbo_frame_tag "menu",
      src: menu_path,
      loading: :lazy do %>
  <div class="spinner">Loading...</div>
<% end %>
```

**Inline editing** with edit/view toggle:
```erb
<%= turbo_frame_tag dom_id(card, :edit) do %>
  <%= link_to "Edit", edit_card_path(card),
        data: { turbo_frame: dom_id(card, :edit) } %>
<% end %>
```

**Target parent frame** without hardcoding:
```erb
<%= form_with model: @card, data: { turbo_frame: "_parent" } do |f| %>
```

**Real-time subscriptions:**
```erb
<%= turbo_stream_from @card %>
<%= turbo_stream_from @card, :activity %>
```
</turbo_frames>

<stimulus_controllers>
## Stimulus Controllers

52 controllers in Fizzy, split 62% reusable, 38% domain-specific.

**Characteristics:**
- Single responsibility per controller
- Configuration via values/classes
- Events for communication
- Private methods with #
- Most under 50 lines

**Examples:**

```javascript
// copy-to-clipboard (25 lines)
import { Controller } from "@hotwired/stimulus"

export default class extends Controller {
  static values = { content: String }

  copy() {
    navigator.clipboard.writeText(this.contentValue)
    this.#showFeedback()
  }

  #showFeedback() {
    this.element.classList.add("copied")
    setTimeout(() => this.element.classList.remove("copied"), 1500)
  }
}
```

```javascript
// auto-click (7 lines)
import { Controller } from "@hotwired/stimulus"

export default class extends Controller {
  connect() {
    this.element.click()
  }
}
```

```javascript
// toggle-class (31 lines)
import { Controller } from "@hotwired/stimulus"

export default class extends Controller {
  static classes = ["toggle"]
  static values = { open: { type: Boolean, default: false } }

  toggle() {
    this.openValue = !this.openValue
  }

  openValueChanged() {
    this.element.classList.toggle(this.toggleClass, this.openValue)
  }
}
```

```javascript
// auto-submit (28 lines) - debounced form submission
import { Controller } from "@hotwired/stimulus"

export default class extends Controller {
  static values = { delay: { type: Number, default: 300 } }

  connect() {
    this.timeout = null
  }

  submit() {
    clearTimeout(this.timeout)
    this.timeout = setTimeout(() => {
      this.element.requestSubmit()
    }, this.delayValue)
  }

  disconnect() {
    clearTimeout(this.timeout)
  }
}
```

```javascript
// dialog (45 lines) - native HTML dialog management
import { Controller } from "@hotwired/stimulus"

export default class extends Controller {
  open() {
    this.element.showModal()
  }

  close() {
    this.element.close()
    this.dispatch("closed")
  }

  clickOutside(event) {
    if (event.target === this.element) this.close()
  }
}
```

```javascript
// local-time (40 lines) - relative time display
import { Controller } from "@hotwired/stimulus"

export default class extends Controller {
  static values = { datetime: String }

  connect() {
    this.#updateTime()
  }

  #updateTime() {
    const date = new Date(this.datetimeValue)
    const now = new Date()
    const diffMinutes = Math.floor((now - date) / 60000)

    if (diffMinutes < 60) {
      this.element.textContent = `${diffMinutes}m ago`
    } else if (diffMinutes < 1440) {
      this.element.textContent = `${Math.floor(diffMinutes / 60)}h ago`
    } else {
      this.element.textContent = `${Math.floor(diffMinutes / 1440)}d ago`
    }
  }
}
```
</stimulus_controllers>

<stimulus_best_practices>
## Stimulus Best Practices

**Values API** over getAttribute:
```javascript
// Good
static values = { delay: { type: Number, default: 300 } }

// Avoid
this.element.getAttribute("data-delay")
```

**Cleanup in disconnect:**
```javascript
disconnect() {
  clearTimeout(this.timeout)
  this.observer?.disconnect()
  document.removeEventListener("keydown", this.boundHandler)
}
```

**Action filters** - `:self` prevents bubbling:
```erb
<div data-action="click->menu#toggle:self">
```

**Helper extraction** - shared utilities in separate modules:
```javascript
// app/javascript/helpers/timing.js
export function debounce(fn, delay) {
  let timeout
  return (...args) => {
    clearTimeout(timeout)
    timeout = setTimeout(() => fn(...args), delay)
  }
}
```

**Event dispatching** for loose coupling:
```javascript
this.dispatch("selected", { detail: { id: this.idValue } })
```
</stimulus_best_practices>

<view_helpers>
## View Helpers (Stimulus-Integrated)

**Dialog helper:**
```ruby
def dialog_tag(id, &block)
  tag.dialog(
    id: id,
    data: {
      controller: "dialog",
      action: "click->dialog#clickOutside keydown.esc->dialog#close"
    },
    &block
  )
end
```

**Auto-submit form helper:**
```ruby
def auto_submit_form_with(model:, delay: 300, **options, &block)
  form_with(
    model: model,
    data: {
      controller: "auto-submit",
      auto_submit_delay_value: delay,
      action: "input->auto-submit#submit"
    },
    **options,
    &block
  )
end
```

**Copy button helper:**
```ruby
def copy_button(content:, label: "Copy")
  tag.button(
    label,
    data: {
      controller: "copy",
      copy_content_value: content,
      action: "click->copy#copy"
    }
  )
end
```
</view_helpers>

<css_architecture>
## CSS Architecture

Vanilla CSS with modern features, no preprocessors.

**CSS @layer** for cascade control:
```css
@layer reset, base, components, modules, utilities;

@layer reset {
  *, *::before, *::after { box-sizing: border-box; }
}

@layer base {
  body { font-family: var(--font-sans); }
}

@layer components {
  .btn { /* button styles */ }
}

@layer modules {
  .card { /* card module styles */ }
}

@layer utilities {
  .hidden { display: none; }
}
```

**OKLCH color system** for perceptual uniformity:
```css
:root {
  --color-primary: oklch(60% 0.15 250);
  --color-success: oklch(65% 0.2 145);
  --color-warning: oklch(75% 0.15 85);
  --color-danger: oklch(55% 0.2 25);
}
```

**Dark mode** via CSS variables:
```css
:root {
  --bg: oklch(98% 0 0);
  --text: oklch(20% 0 0);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: oklch(15% 0 0);
    --text: oklch(90% 0 0);
  }
}
```

**Native CSS nesting:**
```css
.card {
  padding: var(--space-4);

  & .title {
    font-weight: bold;
  }

  &:hover {
    background: var(--bg-hover);
  }
}
```

**~60 minimal utilities** vs Tailwind's hundreds.

**Modern features used:**
- `@starting-style` for enter animations
- `color-mix()` for color manipulation
- `:has()` for parent selection
- Logical properties (`margin-inline`, `padding-block`)
- Container queries
</css_architecture>

<view_patterns>
## View Patterns

**Standard partials** - no ViewComponents:
```erb
<%# app/views/cards/_card.html.erb %>
<article id="<%= dom_id(card) %>" class="card">
  <%= render "cards/header", card: card %>
  <%= render "cards/body", card: card %>
  <%= render "cards/footer", card: card %>
</article>
```

**Fragment caching:**
```erb
<% cache card do %>
  <%= render "cards/card", card: card %>
<% end %>
```

**Collection caching:**
```erb
<%= render partial: "card", collection: @cards, cached: true %>
```

**Simple component naming** - no strict BEM:
```css
.card { }
.card .title { }
.card .actions { }
.card.golden { }
.card.closed { }
```
</view_patterns>

<caching_with_personalization>
## User-Specific Content in Caches

Move personalization to client-side JavaScript to preserve caching:

```erb
<%# Cacheable fragment %>
<% cache card do %>
  <article class="card"
           data-creator-id="<%= card.creator_id %>"
           data-controller="ownership"
           data-ownership-current-user-value="<%= Current.user.id %>">
    <button data-ownership-target="ownerOnly" class="hidden">Delete</button>
  </article>
<% end %>
```

```javascript
// Reveal user-specific elements after cache hit
export default class extends Controller {
  static values = { currentUser: Number }
  static targets = ["ownerOnly"]

  connect() {
    const creatorId = parseInt(this.element.dataset.creatorId)
    if (creatorId === this.currentUserValue) {
      this.ownerOnlyTargets.forEach(el => el.classList.remove("hidden"))
    }
  }
}
```

**Extract dynamic content** to separate frames:
```erb
<% cache [card, board] do %>
  <article class="card">
    <%= turbo_frame_tag card, :assignment,
          src: card_assignment_path(card),
          refresh: :morph %>
  </article>
<% end %>
```

Assignment dropdown updates independently without invalidating parent cache.
</caching_with_personalization>

<broadcasting>
## Broadcasting with Turbo Streams

**Model callbacks** for real-time updates:
```ruby
class Card < ApplicationRecord
  include Broadcastable

  after_create_commit :broadcast_created
  after_update_commit :broadcast_updated
  after_destroy_commit :broadcast_removed

  private
    def broadcast_created
      broadcast_append_to [Current.account, board], :cards
    end

    def broadcast_updated
      broadcast_replace_to [Current.account, board], :cards
    end

    def broadcast_removed
      broadcast_remove_to [Current.account, board], :cards
    end
end
```

**Scope by tenant** using `[Current.account, resource]` pattern.
</broadcasting>
