# Adding Custom Watchers

This guide explains how to add your own sources to Event Watcher.

## Overview

A watcher is a function that:
1. Checks if it's enabled in config
2. Polls an external service (cheap API call, no LLM)
3. Compares the result to saved state
4. Wakes Clawdbot if something changed

## Step-by-Step

### 1. Add Config Section

In `event-watcher.json5`, add a section for your watcher:

```json5
"watchers": {
  "my_source": {
    "enabled": true,
    "apiKey": "your-api-key",
    "someOption": "value"
  }
}
```

### 2. Add Watcher Function

In `event-watcher.sh`, add a function following this template:

```bash
watcher_my_source() {
    # 1. Check if enabled
    local enabled=$(read_config '.watchers.my_source.enabled' 'false')
    if [ "$enabled" != "true" ]; then
        return
    fi
    
    # 2. Read config values
    local api_key=$(read_config '.watchers.my_source.apiKey' '')
    
    # 3. Check the external service
    local result
    result=$(curl -s -H "Authorization: Bearer $api_key" \
        "https://api.example.com/latest")
    
    if [ -z "$result" ]; then
        debug "my_source: API call failed"
        return
    fi
    
    # 4. Extract relevant value (e.g., latest item ID)
    local current_id=$(echo "$result" | jq -r '.items[0].id')
    
    # 5. Compare to saved state
    local last_id=$(read_state "my_source" "last_id" "")
    
    debug "my_source: current=$current_id, last=$last_id"
    
    # 6. If changed, update state and wake Clawdbot
    if [ "$current_id" != "$last_id" ] && [ -n "$current_id" ]; then
        write_state "my_source" "last_id" "\"$current_id\""
        write_state "my_source" "last_check" "$(date +%s)"
        
        # Extract details for the wake message
        local title=$(echo "$result" | jq -r '.items[0].title')
        
        wake_clawdbot "[Event Watcher] New item from my_source: $title"
    else
        # No change, just update timestamp
        write_state "my_source" "last_check" "$(date +%s)"
    fi
}
```

### 3. Register the Watcher

In `event-watcher.sh`, find the `run_all_watchers` function and add your watcher:

```bash
run_all_watchers() {
    watcher_gmail
    watcher_calendar
    watcher_my_source  # <-- Add this line
}
```

## Helper Functions

### Reading Config

```bash
# Read a config value (supports nested paths)
local value=$(read_config '.watchers.my_source.option' 'default_value')
```

### Reading/Writing State

```bash
# Read state (returns default if not set)
local last=$(read_state "my_source" "key" "default")

# Write state (value must be valid JSON)
write_state "my_source" "key" "\"string_value\""
write_state "my_source" "count" "42"
write_state "my_source" "flag" "true"
```

### Waking Clawdbot

```bash
# Wake with default mode (from config)
wake_clawdbot "Description of what needs attention"

# Wake immediately
wake_clawdbot "Urgent: something happened" "now"

# Wait for next heartbeat
wake_clawdbot "FYI: something changed" "next-heartbeat"
```

### Logging

```bash
log "Normal message"          # Always logged
debug "Verbose message"       # Only with EVENT_WATCHER_DEBUG=1
error "Something went wrong"  # Logged to stderr
```

## Examples

### RSS Feed Watcher

```bash
watcher_rss() {
    local enabled=$(read_config '.watchers.rss.enabled' 'false')
    if [ "$enabled" != "true" ]; then return; fi
    
    local feed_url=$(read_config '.watchers.rss.url' '')
    
    # Get latest item GUID
    local guid
    guid=$(curl -s "$feed_url" | xmllint --xpath 'string(//item[1]/guid)' - 2>/dev/null)
    
    local last_guid=$(read_state "rss" "last_guid" "")
    
    if [ "$guid" != "$last_guid" ] && [ -n "$guid" ]; then
        local title
        title=$(curl -s "$feed_url" | xmllint --xpath 'string(//item[1]/title)' - 2>/dev/null)
        
        write_state "rss" "last_guid" "\"$guid\""
        wake_clawdbot "[RSS] New post: $title"
    fi
}
```

### File Change Watcher

```bash
watcher_file() {
    local enabled=$(read_config '.watchers.file.enabled' 'false')
    if [ "$enabled" != "true" ]; then return; fi
    
    local path=$(read_config '.watchers.file.path' '')
    path="${path/#\~/$HOME}"
    
    if [ ! -f "$path" ]; then return; fi
    
    local current_hash=$(md5sum "$path" | cut -d' ' -f1)
    local last_hash=$(read_state "file" "hash" "")
    
    if [ "$current_hash" != "$last_hash" ]; then
        write_state "file" "hash" "\"$current_hash\""
        wake_clawdbot "[File] Changed: $path"
    fi
}
```

### Health Check Watcher

```bash
watcher_health() {
    local enabled=$(read_config '.watchers.health.enabled' 'false')
    if [ "$enabled" != "true" ]; then return; fi
    
    local url=$(read_config '.watchers.health.url' '')
    
    local status
    status=$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo "000")
    
    local last_status=$(read_state "health" "status" "200")
    
    if [ "$status" != "$last_status" ]; then
        write_state "health" "status" "\"$status\""
        
        if [ "$status" != "200" ]; then
            wake_clawdbot "[Health] Service unhealthy: $url returned $status" "now"
        else
            wake_clawdbot "[Health] Service recovered: $url is back up" "next-heartbeat"
        fi
    fi
}
```

## Best Practices

1. **Keep it lightweight** - No LLM calls, no heavy processing
2. **Handle errors gracefully** - Don't crash on API failures
3. **Use debug logging** - Helps troubleshoot without spam
4. **Include context in wake messages** - Tell Clawdbot what needs attention
5. **Consider rate limits** - Don't hammer APIs too frequently
6. **Test with `--debug`** - Run with `EVENT_WATCHER_DEBUG=1` to verify

## Testing

```bash
# Run once with debug output
EVENT_WATCHER_DEBUG=1 ./event-watcher.sh

# Check state file
cat ~/.clawdbot/event-watcher-state.json | jq .

# Check logs
tail -f ~/.clawdbot/logs/event-watcher.log
```
