<overview>
When building skills that make API calls requiring credentials (API keys, tokens, secrets), follow this protocol to prevent credentials from appearing in chat.
</overview>

<the_problem>
Raw curl commands with environment variables expose credentials:

```bash
# ❌ BAD - API key visible in chat
curl -H "Authorization: Bearer $API_KEY" https://api.example.com/data
```

When Claude executes this, the full command with expanded `$API_KEY` appears in the conversation.
</the_problem>

<the_solution>
Use `~/.openclaw/scripts/secure-api.sh` - a wrapper that loads credentials internally.

<for_supported_services>
```bash
# ✅ GOOD - No credentials visible
~/.openclaw/scripts/secure-api.sh <service> <operation> [args]

# Examples:
~/.openclaw/scripts/secure-api.sh facebook list-campaigns
~/.openclaw/scripts/secure-api.sh ghl search-contact "email@example.com"
```
</for_supported_services>

<adding_new_services>
When building a new skill that requires API calls:

1. **Add operations to the wrapper** (`~/.openclaw/scripts/secure-api.sh`):

```bash
case "$SERVICE" in
    yourservice)
        case "$OPERATION" in
            list-items)
                curl -s -G \
                    -H "Authorization: Bearer $YOUR_API_KEY" \
                    "https://api.yourservice.com/items"
                ;;
            get-item)
                ITEM_ID=$1
                curl -s -G \
                    -H "Authorization: Bearer $YOUR_API_KEY" \
                    "https://api.yourservice.com/items/$ITEM_ID"
                ;;
            *)
                echo "Unknown operation: $OPERATION" >&2
                exit 1
                ;;
        esac
        ;;
esac
```

2. **Add profile support to the wrapper** (if service needs multiple accounts):

```bash
# In secure-api.sh, add to profile remapping section:
yourservice)
    SERVICE_UPPER="YOURSERVICE"
    YOURSERVICE_API_KEY=$(eval echo \$${SERVICE_UPPER}_${PROFILE_UPPER}_API_KEY)
    YOURSERVICE_ACCOUNT_ID=$(eval echo \$${SERVICE_UPPER}_${PROFILE_UPPER}_ACCOUNT_ID)
    ;;
```

3. **Add credential placeholders to `~/.openclaw/.env`** using profile naming:

```bash
# Check if entries already exist
grep -q "YOURSERVICE_MAIN_API_KEY=" ~/.openclaw/.env 2>/dev/null || \
  echo -e "\n# Your Service - Main profile\nYOURSERVICE_MAIN_API_KEY=\nYOURSERVICE_MAIN_ACCOUNT_ID=" >> ~/.openclaw/.env

echo "Added credential placeholders to ~/.openclaw/.env - user needs to fill them in"
```

4. **Document profile workflow in your SKILL.md**:

```markdown
## Profile Selection Workflow

**CRITICAL:** Always use profile selection to prevent using wrong account credentials.

### When user requests YourService operation:

1. **Check for saved profile:**
   ```bash
   ~/.openclaw/scripts/profile-state get yourservice
   ```

2. **If no profile saved, discover available profiles:**
   ```bash
   ~/.openclaw/scripts/list-profiles yourservice
   ```

3. **If only ONE profile:** Use it automatically and announce:
   ```
   "Using YourService profile 'main' to list items..."
   ```

4. **If MULTIPLE profiles:** Ask user which one:
   ```
   "Which YourService profile: main, clienta, or clientb?"
   ```

5. **Save user's selection:**
   ```bash
   ~/.openclaw/scripts/profile-state set yourservice <selected_profile>
   ```

6. **Always announce which profile before calling API:**
   ```
   "Using YourService profile 'main' to list items..."
   ```

7. **Make API call with profile:**
   ```bash
   ~/.openclaw/scripts/secure-api.sh yourservice:<profile> list-items
   ```

## Secure API Calls

All API calls use profile syntax:

```bash
~/.openclaw/scripts/secure-api.sh yourservice:<profile> <operation> [args]

# Examples:
~/.openclaw/scripts/secure-api.sh yourservice:main list-items
~/.openclaw/scripts/secure-api.sh yourservice:main get-item <ITEM_ID>
```

**Profile persists for session:** Once selected, use same profile for subsequent operations unless user explicitly changes it.
```
</adding_new_services>
</the_solution>

<pattern_guidelines>
<simple_get_requests>
```bash
curl -s -G \
    -H "Authorization: Bearer $API_KEY" \
    "https://api.example.com/endpoint"
```
</simple_get_requests>

<post_with_json_body>
```bash
ITEM_ID=$1
curl -s -X POST \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d @- \
    "https://api.example.com/items/$ITEM_ID"
```

Usage:
```bash
echo '{"name":"value"}' | ~/.openclaw/scripts/secure-api.sh service create-item
```
</post_with_json_body>

<post_with_form_data>
```bash
curl -s -X POST \
    -F "field1=value1" \
    -F "field2=value2" \
    -F "access_token=$API_TOKEN" \
    "https://api.example.com/endpoint"
```
</post_with_form_data>
</pattern_guidelines>

<credential_storage>
**Location:** `~/.openclaw/.env` (global for all skills, accessible from any directory)

**Format:**
```bash
# Service credentials
SERVICE_API_KEY=your-key-here
SERVICE_ACCOUNT_ID=account-id-here

# Another service
OTHER_API_TOKEN=token-here
OTHER_BASE_URL=https://api.other.com
```

**Loading in script:**
```bash
set -a
source ~/.openclaw/.env 2>/dev/null || { echo "Error: ~/.openclaw/.env not found" >&2; exit 1; }
set +a
```
</credential_storage>

<best_practices>
1. **Never use raw curl with `$VARIABLE` in skill examples** - always use the wrapper
2. **Add all operations to the wrapper** - don't make users figure out curl syntax
3. **Auto-create credential placeholders** - add empty fields to `~/.openclaw/.env` immediately when creating the skill
4. **Keep credentials in `~/.openclaw/.env`** - one central location, works everywhere
5. **Document each operation** - show examples in SKILL.md
6. **Handle errors gracefully** - check for missing env vars, show helpful error messages
</best_practices>

<testing>
Test the wrapper without exposing credentials:

```bash
# This command appears in chat
~/.openclaw/scripts/secure-api.sh facebook list-campaigns

# But API keys never appear - they're loaded inside the script
```

Verify credentials are loaded:
```bash
# Check .env exists
ls -la ~/.openclaw/.env

# Check specific variables (without showing values)
grep -q "YOUR_API_KEY=" ~/.openclaw/.env && echo "API key configured" || echo "API key missing"
```
</testing>
