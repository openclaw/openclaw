# Linear Skill Setup

## Installation

1. **Get your Linear API key**
   - Go to https://linear.app/settings/api
   - Click "Create new key"
   - Copy the key (starts with `lin_api_...`)

2. **Set environment variable**

   **Option A: Store in `.env` file**

   ```bash
   echo "LINEAR_API_KEY=lin_api_..." >> ~/.openclaw/.env
   ```

   **Option B: Export in shell**

   ```bash
   export LINEAR_API_KEY="lin_api_..."
   # Add to ~/.zshrc or ~/.bashrc to persist
   ```

3. **Verify setup**

   ```bash
   cd /Users/awiley/openclaw/skills/linear
   python3 scripts/linear.py query --limit 3
   ```

   Should show recent issues from your Linear workspace.

## Quick Test

```bash
# See your assigned issues
python3 scripts/linear.py query --assignee @me

# Show issue details
python3 scripts/linear.py show STX-41

# Create a test issue
python3 scripts/linear.py create \
  --title "Test issue from Linear skill" \
  --description "Testing the new Linear integration" \
  --project STX \
  --priority 4
```

## Usage

Once installed, the skill is automatically available. Just mention Linear operations in conversation:

- "Create a Linear issue for this bug"
- "What's in my current sprint?"
- "Update STX-41 to In Progress"
- "Link this commit to STX-42"

See `SKILL.md` for detailed examples.
