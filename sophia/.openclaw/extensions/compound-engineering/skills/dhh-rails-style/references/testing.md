# Testing - DHH Rails Style

## Core Philosophy

"Minitest with fixtures - simple, fast, deterministic." The approach prioritizes pragmatism over convention.

## Why Minitest Over RSpec

- **Simpler**: Less DSL magic, plain Ruby assertions
- **Ships with Rails**: No additional dependencies
- **Faster boot times**: Less overhead
- **Plain Ruby**: No specialized syntax to learn

## Fixtures as Test Data

Rather than factories, fixtures provide preloaded data:
- Loaded once, reused across tests
- No runtime object creation overhead
- Explicit relationship visibility
- Deterministic IDs for easier debugging

### Fixture Structure
```yaml
# test/fixtures/users.yml
david:
  identity: david
  account: basecamp
  role: admin

jason:
  identity: jason
  account: basecamp
  role: member

# test/fixtures/rooms.yml
watercooler:
  name: Water Cooler
  creator: david
  direct: false

# test/fixtures/messages.yml
greeting:
  body: Hello everyone!
  room: watercooler
  creator: david
```

### Using Fixtures in Tests
```ruby
test "sending a message" do
  user = users(:david)
  room = rooms(:watercooler)

  # Test with fixture data
end
```

### Dynamic Fixture Values
ERB enables time-sensitive data:
```yaml
recent_card:
  title: Recent Card
  created_at: <%= 1.hour.ago %>

old_card:
  title: Old Card
  created_at: <%= 1.month.ago %>
```

## Test Organization

### Unit Tests
Verify business logic using setup blocks and standard assertions:

```ruby
class CardTest < ActiveSupport::TestCase
  setup do
    @card = cards(:one)
    @user = users(:david)
  end

  test "closing a card creates a closure" do
    assert_difference -> { Card::Closure.count } do
      @card.close(creator: @user)
    end

    assert @card.closed?
    assert_equal @user, @card.closure.creator
  end

  test "reopening a card destroys the closure" do
    @card.close(creator: @user)

    assert_difference -> { Card::Closure.count }, -1 do
      @card.reopen
    end

    refute @card.closed?
  end
end
```

### Integration Tests
Test full request/response cycles:

```ruby
class CardsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @user = users(:david)
    sign_in @user
  end

  test "closing a card" do
    card = cards(:one)

    post card_closure_path(card)

    assert_response :success
    assert card.reload.closed?
  end

  test "unauthorized user cannot close card" do
    sign_in users(:guest)
    card = cards(:one)

    post card_closure_path(card)

    assert_response :forbidden
    refute card.reload.closed?
  end
end
```

### System Tests
Browser-based tests using Capybara:

```ruby
class MessagesTest < ApplicationSystemTestCase
  test "sending a message" do
    sign_in users(:david)
    visit room_path(rooms(:watercooler))

    fill_in "Message", with: "Hello, world!"
    click_button "Send"

    assert_text "Hello, world!"
  end

  test "editing own message" do
    sign_in users(:david)
    visit room_path(rooms(:watercooler))

    within "#message_#{messages(:greeting).id}" do
      click_on "Edit"
    end

    fill_in "Message", with: "Updated message"
    click_button "Save"

    assert_text "Updated message"
  end

  test "drag and drop card to new column" do
    sign_in users(:david)
    visit board_path(boards(:main))

    card = find("#card_#{cards(:one).id}")
    target = find("#column_#{columns(:done).id}")

    card.drag_to target

    assert_selector "#column_#{columns(:done).id} #card_#{cards(:one).id}"
  end
end
```

## Advanced Patterns

### Time Testing
Use `travel_to` for deterministic time-dependent assertions:

```ruby
test "card expires after 30 days" do
  card = cards(:one)

  travel_to 31.days.from_now do
    assert card.expired?
  end
end
```

### External API Testing with VCR
Record and replay HTTP interactions:

```ruby
test "fetches user data from API" do
  VCR.use_cassette("user_api") do
    user_data = ExternalApi.fetch_user(123)

    assert_equal "John", user_data[:name]
  end
end
```

### Background Job Testing
Assert job enqueueing and email delivery:

```ruby
test "closing card enqueues notification job" do
  card = cards(:one)

  assert_enqueued_with(job: NotifyWatchersJob, args: [card]) do
    card.close
  end
end

test "welcome email is sent on signup" do
  assert_emails 1 do
    Identity.create!(email: "new@example.com")
  end
end
```

### Testing Turbo Streams
```ruby
test "message creation broadcasts to room" do
  room = rooms(:watercooler)

  assert_turbo_stream_broadcasts [room, :messages] do
    room.messages.create!(body: "Test", creator: users(:david))
  end
end
```

## Testing Principles

### 1. Test Observable Behavior
Focus on what the code does, not how it does it:

```ruby
# ❌ Testing implementation
test "calls notify method on each watcher" do
  card.expects(:notify).times(3)
  card.close
end

# ✅ Testing behavior
test "watchers receive notifications when card closes" do
  assert_difference -> { Notification.count }, 3 do
    card.close
  end
end
```

### 2. Don't Mock Everything

```ruby
# ❌ Over-mocked test
test "sending message" do
  room = mock("room")
  user = mock("user")
  message = mock("message")

  room.expects(:messages).returns(stub(create!: message))
  message.expects(:broadcast_create)

  MessagesController.new.create
end

# ✅ Test the real thing
test "sending message" do
  sign_in users(:david)
  post room_messages_url(rooms(:watercooler)),
    params: { message: { body: "Hello" } }

  assert_response :success
  assert Message.exists?(body: "Hello")
end
```

### 3. Tests Ship with Features
Same commit, not TDD-first but together. Neither before (strict TDD) nor after (deferred testing).

### 4. Security Fixes Always Include Regression Tests
Every security fix must include a test that would have caught the vulnerability.

### 5. Integration Tests Validate Complete Workflows
Don't just test individual pieces - test that they work together.

## File Organization

```
test/
├── controllers/         # Integration tests for controllers
├── fixtures/           # YAML fixtures for all models
├── helpers/            # Helper method tests
├── integration/        # API integration tests
├── jobs/               # Background job tests
├── mailers/            # Mailer tests
├── models/             # Unit tests for models
├── system/             # Browser-based system tests
└── test_helper.rb      # Test configuration
```

## Test Helper Setup

```ruby
# test/test_helper.rb
ENV["RAILS_ENV"] ||= "test"
require_relative "../config/environment"
require "rails/test_help"

class ActiveSupport::TestCase
  fixtures :all

  parallelize(workers: :number_of_processors)
end

class ActionDispatch::IntegrationTest
  include SignInHelper
end

class ApplicationSystemTestCase < ActionDispatch::SystemTestCase
  driven_by :selenium, using: :headless_chrome
end
```

## Sign In Helper

```ruby
# test/support/sign_in_helper.rb
module SignInHelper
  def sign_in(user)
    session = user.identity.sessions.create!
    cookies.signed[:session_id] = session.id
  end
end
```
