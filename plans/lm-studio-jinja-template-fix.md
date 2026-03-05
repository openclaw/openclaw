# LM Studio Jinja Template Fix Plan

## Problem Analysis

**Error:** `Error rendering prompt with jinja template: "Only user and assistant roles are supported!"`

**Context:**
- Model: `mistralai/mistral-7b-instruct-v0.3` running in LM Studio
- Error occurs when conversation has 3+ messages
- The Mistral model's default Jinja template only supports `user` and `assistant` roles
- AI agent systems typically send `system` role messages for system prompts/instructions

**Root Cause:**
The default prompt template for Mistral models in LM Studio explicitly filters for only `user` and `assistant` roles:
```jinja
{% for message in messages %}
{% if message['role'] == 'user' or message['role'] == 'assistant' %}
...
{% endif %}
{% endfor %}
```

When a `system` role message is present, it gets filtered out or causes an error depending on the template implementation.

## Solution Options

### Option 1: Modify the Jinja Template (Recommended)
Create a custom prompt template that handles `system` and `tool` roles by converting them appropriately.

**Approach:**
1. Convert `system` role messages to `user` role with special formatting
2. Convert `tool` role messages to `assistant` role with special formatting
3. Or prepend system content to the first user message

### Option 2: Pre-process Messages Before Sending
Modify the client code (AI agent) to convert system messages to user messages before sending to LM Studio.

### Option 3: Use a Different Model (EASIEST)
Switch to a model that natively supports system roles (e.g., Llama-3, Qwen, or other instruction-tuned models with updated templates).

**Recommended Models (LM Studio compatible with full role support):**

| Model | Size | System Role Support | Notes |
|-------|------|---------------------|-------|
| `meta-llama/Llama-3.1-8B-Instruct` | 8B | ✅ Native | Best balance of quality and speed |
| `meta-llama/Llama-3.2-3B-Instruct` | 3B | ✅ Native | Fast, good for testing |
| `Qwen/Qwen2.5-7B-Instruct` | 7B | ✅ Native | Excellent multilingual support |
| `microsoft/Phi-4-mini-instruct` | 3.8B | ✅ Native | Very fast, good quality |
| `google/gemma-2-2b-it` | 2B | ✅ Native | Lightweight, efficient |
| `NousResearch/Hermes-3-Llama-3.1-8B` | 8B | ✅ Native | Fine-tuned for assistants |

**Models to AVOID (limited role support):**
- `mistralai/mistral-7b-instruct-v0.3` ❌ Only user/assistant roles
- Older Mistral v0.1/v0.2 variants ❌ Same issue
- Some legacy Llama-2 models ❌ May have template issues

## Implementation Plan

### T001 - Diagnose Current Message Flow
- [ ] Identify where system messages are being added
- [ ] Capture a sample request payload showing all message roles
- [ ] Document the conversation flow that triggers the error

### T002 - Access LM Studio Model Configuration
- [ ] Locate LM Studio model directory (typically `~/.cache/lm-studio/models/` or configured path)
- [ ] Find the Mistral model configuration files
- [ ] Identify where Jinja templates are stored

### T003 - Create Custom Jinja Template
Create a modified template that handles all roles:

```jinja
{# Modified Mistral Template with System Role Support #}
{% for message in messages %}
{% if message['role'] == 'system' %}
{# Convert system to user message with special prefix #}
{{ '<s>[INST] System: ' + message['content'] + ' [/INST]</s>' }}
{% elif message['role'] == 'user' %}
{{ '<s>[INST] ' + message['content'] + ' [/INST]</s>' }}
{% elif message['role'] == 'assistant' %}
{{ message['content'] + '</s>' }}
{% elif message['role'] == 'tool' %}
{# Convert tool results to assistant format #}
{{ '[TOOL RESULT] ' + message['content'] + '</s>' }}
{% endif %}
{% endfor %}
```

### T004 - Apply Template in LM Studio
- [ ] Open LM Studio UI
- [ ] Navigate to model settings for `mistralai/mistral-7b-instruct-v0.3`
- [ ] Go to "Prompt Template" section
- [ ] Paste the custom Jinja template
- [ ] Save configuration

### T005 - Test the Fix
- [ ] Restart LM Studio server
- [ ] Send a conversation with system, user, and assistant messages
- [ ] Verify no Jinja template errors occur
- [ ] Verify model responds correctly to system instructions

### T006 - Document the Solution
- [ ] Create documentation for future reference
- [ ] Include the working Jinja template
- [ ] Note any model-specific considerations

## Alternative: Quick Fix via LM Studio UI

If you want to fix this quickly through LM Studio's interface:

1. Open LM Studio
2. Go to "My Models" 
3. Select `mistralai/mistral-7b-instruct-v0.3`
4. Click "Model Settings"
5. Scroll to "Prompt Template"
6. Replace the template with one that handles system roles:

```jinja
{%- for message in messages %}
    {%- if message['role'] == 'system' %}
        {{- '[SYSTEM] ' + message['content'] + '\n' }}
    {%- elif message['role'] == 'user' %}
        {{- '[USER] ' + message['content'] + '\n' }}
    {%- elif message['role'] == 'assistant' %}
        {{- '[ASSISTANT] ' + message['content'] + '\n' }}
    {%- endif %}
{%- endfor %}
```

## References

- LM Studio Documentation: https://lmstudio.ai/docs
- Mistral Prompt Format: https://docs.mistral.ai/models/
- Jinja Template Documentation: https://jinja.palletsprojects.com/
