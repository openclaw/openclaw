# Tlon Channel Hooks

Hooks are hoon functions that modify events, cause effects, and/or build state for channels.

## Version Compatibility

Hooks are tightly coupled to `channels-server` / `tlon-apps` types.
When docs/examples drift from runtime types, compilation can fail even if logic is correct.

Recommended practice:
- Pin your local references to a known `tlon-apps` commit/tag
- Record that version in PRs when adding/updating hooks
- Prefer examples in this folder that were verified against the current runtime

## Hook Structure

```hoon
++  hook
  $:  id=id-hook
      version=%0
      name=@t
      meta=data:m
      src=@t
      compiled=(unit vase)
      state=vase
      config=(map nest config)
  ==
```

- `id` - unique identifier (@uv format)
- `version` - the version this hook was written for
- `name` - human-readable display name
- `meta` - standard metadata (title/image/desc/cover)
- `src` - the source code for the hook
- `compiled` - result of compiling hoon to nock
- `state` - container to collect/persist data
- `config` - configurations for each channel

## Events

Hooks respond to four event types:

```hoon
+$  event
  $%  [%on-post on-post]
      [%on-reply on-reply]
      [%cron ~]
      [%wake waiting-hook]
  ==
```

### on-post events
```hoon
+$  on-post
  $%  [%add post=v-post]
      [%edit original=v-post =essay]
      [%del original=v-post]
      [%react post=v-post =ship react=(unit react)]
  ==
```

### on-reply events
```hoon
+$  on-reply
  $%  [%add parent=v-post reply=v-reply]
      [%edit parent=v-post original=v-reply =memo]
      [%del parent=v-post original=v-reply]
      [%react parent=v-post reply=v-reply =ship react=(unit react)]
  ==
```

## Bowl (Context)

Hooks receive ambient state via the bowl:

```hoon
+$  bowl
  $:  channel=(unit [=nest v-channel])   :: current channel (null for global cron)
      group=(unit group-ui:g)            :: group data
      channels=v-channels                :: all hosted channels
      =hook                              :: this hook's data
      =config                            :: channel-specific config
      now=time                           :: current time
      our=ship                           :: host ship
      src=ship                           :: triggering ship
      eny=@                              :: entropy
  ==
```

**Important:** Access patterns depend on whether you use a face:
- `|= [=event:h =bowl:h]` (with face) → access via `config.bowl`, `channel.bowl`, `state.hook.bowl`
- `|= [=event:h bowl:h]` (no face) → access via `config`, `channel`, `state.hook`

## Return Type

```hoon
+$  outcome  (each return tang)

+$  return
  $:  result=event-result
      effects=(list effect)
      new-state=vase
  ==

+$  event-result
  $%  [%allowed =event]      :: allow event, optionally transform it
      [%denied msg=(unit cord)]  :: block event with optional message
  ==
```

## Effects

Hooks can trigger actions on other agents:

```hoon
+$  effect
  $%  [%channels =a-channels]   :: channel actions
      [%groups =action:g]       :: group actions (ban, kick, etc)
      [%activity =action:a]     :: activity actions
      [%dm =action:dm:ch]       :: DM actions
      [%club =action:club:ch]   :: group DM actions
      [%contacts =action:co]    :: contact actions
      [%wait waiting-hook]      :: schedule delayed execution
  ==
```

### Channel Effects

The most common effect pattern for channel actions:

```hoon
::  React to a post
[%channels %channel nest [%post [%add-react post-id ship emoji]]]

::  Delete a post
[%channels %channel nest %post %del post-id]
```

**Note:** Use actual unicode emoji (`'👍'`, `'🔥'`) not shortcodes (`:thumbsup:`).

## Config

Config is `(map @t *)` on the Hoon side.
From CLI, values are sent as text and then clammed/coerced in-hook.
Use clam (`;;`) to extract typed values with defaults:

```hoon
::  With bowl face (=bowl:h)
=+  ;;(delay=@dr (~(gut by config.bowl) 'delay' ~s30))
=+  ;;(emoji=cord (~(gut by config.bowl) 'emoji' '👍'))

::  Without bowl face (bowl:h)
=+  ;;(delay=@dr (~(gut by config) 'delay' ~s30))
```

CLI tips:
- Prefer simple text/cord values first (`password=owl-pass`)
- For booleans/durations, verify with `hooks get <id>` after setting config
- If a config poke fails, inspect the exact update payload from CLI output

## Plaintext Helper Pattern

The hook subject includes a `flatten` gate via `channel-utils`.
For moderation/search-like use cases, prefer this default:

```hoon
=/  text=tape
  (trip (flatten content.post.event))
```

`flatten` intentionally focuses on searchable/user-visible text and may skip some structures
(e.g. code blocks or other rich content forms depending on story shape).

If you need strict/full extraction (including code), implement a custom story walker gate.

## Writing a Hook

Basic hook template (with bowl face):

```hoon
|=  [=event:h =bowl:h]
^-  outcome:h
::  Return success with: [allowed-result effects new-state]
&+[[[%allowed event] ~] state.hook.bowl]
```

Basic hook template (without bowl face):

```hoon
|=  [=event:h bowl:h]
^-  outcome:h
::  Return success with: [allowed-result effects new-state]
&+[[[%allowed event] ~] state.hook]
```

### Example: Auto-react to new posts

```hoon
:: Auto-react hook: reacts to new posts with configured emoji
:: Config: emoji (default 👍)
::
|=  [=event:h =bowl:h]
^-  outcome:h
::  Extract config with defaults
=+  ;;(emoji=cord (~(gut by config.bowl) 'emoji' '👍'))
::  Only react to new posts
?.  ?=([%on-post %add *] event)
  &+[[[%allowed event] ~] state.hook.bowl]
::  Don't react to our own posts
?:  =(author.post.event our.bowl)
  &+[[[%allowed event] ~] state.hook.bowl]
::  Need channel context
?~  channel.bowl
  &+[[[%allowed event] ~] state.hook.bowl]
::  React to the post
=/  react-effect=effect:h
  :*  %channels
      %channel
      nest.u.channel.bowl
      [%post [%add-react id.post.event our.bowl emoji]]
  ==
&+[[[%allowed event] [react-effect ~]] state.hook.bowl]
```

**Key points:**
- Check `author.post.event` (not `src.bowl`) for self-detection
- Check `channel.bowl` for null before accessing `u.channel.bowl`
- Effect structure: `[%channels %channel nest [%post [%add-react ...]]]`
- Use actual emoji unicode, not shortcodes

### Example: Disappearing messages (cron)

From [tloncorp/hooks](https://github.com/tloncorp/hooks/blob/master/hooks/disappearing.hoon):

```hoon
:: Disappearing messages: deletes posts older than configured delay
:: Config: delay (default ~s30 = 30 seconds)
::
|=  [=event:h bowl:h]
^-  outcome:h
=-  &+[[[%allowed event] -] state.hook]
?.  ?=(%cron -.event)  ~
^-  (list effect:h)
=+  ;;(delay=@dr (~(gut by config) 'delay' ~s30))
=/  cutoff  (sub now delay)
?~  channel  ~
%+  murn
  (tap:on-v-posts:c (lot:on-v-posts:c posts.u.channel ~ `cutoff))
|=  [=id-post:c post=(may:c v-post:c)]
^-  (unit effect:h)
?:  ?=(%| -.post)  ~
`[%channels %channel nest.u.channel %post %del id-post]
```

**Key points:**
- Uses `bowl:h` without face → access `config`, `channel`, `state.hook` directly
- Uses `on-v-posts:c` ordered map with `lot:` for cutoff filtering
- Uses `(may:c v-post:c)` type - posts can be deleted (`%|`) or present (`%&`)
- Check `?=(%| -.post)` to skip already-deleted posts

### Example: Word filter

```hoon
:: Word filter hook: blocks posts containing banned words
:: Config: words (comma-separated list of words to block)
::
|=  [=event:h =bowl:h]
^-  outcome:h
|^
::  Only filter new posts
?.  ?=([%on-post %add *] event)
  &+[[[%allowed event] ~] state.hook.bowl]
::  Get banned words from config (comma-separated)
=+  ;;(words-cord=cord (~(gut by config.bowl) 'words' ''))
::  Skip if no words configured
?:  =('' words-cord)
  &+[[[%allowed event] ~] state.hook.bowl]
::  Split on commas into list of tapes
=/  banned=(list tape)
  (split-on-comma (trip words-cord))
::  Get message content
=/  content=tape  (extract-text content.post.event)
::  Check if any banned word appears in content
=/  has-banned=?
  %+  lien  banned
  |=  word=tape
  !=(~ (find word content))
::  If found, deny
?:  has-banned
  &+[[[%denied `'Message contains prohibited content'] ~] state.hook.bowl]
::  Otherwise allow
&+[[[%allowed event] ~] state.hook.bowl]
::
++  split-on-comma
  |=  txt=tape
  ^-  (list tape)
  =/  idx  (find "," txt)
  ?~  idx
    ?~  txt  *(list tape)
    ~[txt]
  :-  (scag u.idx txt)
  $(txt (slag +(u.idx) txt))
::
++  extract-text
  |=  =story:c
  ^-  tape
  ?~  story  ""
  =/  verse  i.story
  ?.  ?=(%inline -.verse)  ""
  ?~  p.verse  ""
  =/  inl  i.p.verse
  ?@  inl
    (trip inl)
  ""
--
```

**Key points:**
- Access post content via `content.post.event`
- Use `lien` to check if any word in list matches
- Helper arms (`++`) for text processing go inside `|^` ... `--`
- Config supports comma-separated values

## CLI Commands

```bash
# Add a hook
tlon hooks add "my-hook" ./hook.hoon

# Configure for a channel
tlon hooks config <id> chat/~host/channel delay=~m5 emoji=👍

# Set execution order
tlon hooks order chat/~host/channel <id1> <id2>

# Schedule periodic execution
tlon hooks cron <id> ~h1 --nest chat/~host/channel

# List hooks
tlon hooks list

# Watch for hook updates (debugging)
tlon hooks watch
```

## Testing Hooks (Dojo)

Test without affecting channels:

```
-groups!hooks-run <event> [%origin nest optional-state optional-config] <src>
```

## Common Pitfalls

1. **Bowl face confusion** - `=bowl:h` vs `bowl:h` changes how you access fields
2. **Wrong effect structure** - channel effects need exact nesting: `[%channels %channel nest ...]`
3. **Emoji shortcodes** - use actual unicode (`'👍'`), not `:thumbsup:`
4. **Self-detection** - check `author.post.event`, not `src.bowl`
5. **Deleted posts** - in cron, posts can be `%|` (deleted) or `%&` (present)

## Type References

- Full hooks types: https://github.com/tloncorp/tlon-apps/blob/develop/desk/sur/hooks.hoon
- Channel types (v-post, v-reply, etc): https://github.com/tloncorp/tlon-apps/blob/develop/desk/sur/channels.hoon
- Official hooks examples: https://github.com/tloncorp/hooks
