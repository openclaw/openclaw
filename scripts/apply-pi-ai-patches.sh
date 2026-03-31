#!/bin/bash
# apply-pi-ai-patches.sh — Reapply openclaw compatibility patches to @mariozechner/pi-ai
# Run after `pnpm install` to patch all pi-ai versions in node_modules.
#
# Patches applied:
#   1. Assistant content as string (not array) — prevents models from mimicking JSON structure
#   2. Empty tool call filter — strips toolCall blocks with empty names (NVIDIA GLM-5 bug)
#   3. Reasoning→text fallback — promotes thinking to text when no text/tool blocks exist (skips reasoning=true models)
#   4. 120s per-request timeout — enables faster failover instead of 10-min default hang
#   5. Kimi K2.5 tool call ID normalization — uses functions.name:idx format (4x reliability)
#   6. Text-to-tool-call fallback parser — recovers tool calls output as text content
#   7. Strip reasoning_content from history — prevents format contamination + saves tokens
#   8. Global API key fallback — recovers key from OpenClaw runtime when options.apiKey is lost

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

# Find all pi-ai openai-completions.js files (check both .pnpm and hoisted paths)
FILES=$(find "$ROOT/node_modules/.pnpm" -path '*pi-ai*/dist/providers/openai-completions.js' 2>/dev/null)
if [ -z "$FILES" ]; then
    FILES=$(find "$ROOT/node_modules" -path '*pi-ai*/dist/providers/openai-completions.js' -not -path '*/node_modules/*/node_modules/*' 2>/dev/null)
fi

if [ -z "$FILES" ]; then
    echo "ERROR: No pi-ai openai-completions.js files found in node_modules"
    exit 1
fi

PATCHED=0
SKIPPED=0

for FILE in $FILES; do
    VERSION=$(echo "$FILE" | grep -oP 'pi-ai@\K[0-9.]+' || echo "local")
    echo "--- Patching pi-ai@${VERSION}: $(basename "$FILE")"

    set +e
    python3 - "$FILE" <<'PYTHON_PATCH'
import sys, re

filepath = sys.argv[1]
with open(filepath, 'r') as f:
    code = f.read()

changed = False

# ============================================================
# PATCH 1: Assistant content as plain string (not array)
# ============================================================
# Original code has an if/else: github-copilot gets .join(""),
# everyone else gets array of {type:"text",text:...} objects.
# We make ALL providers use .join("") because array format causes
# models like DeepSeek to mimic the JSON structure in responses.

if 'Send assistant content as a plain string for all providers' in code:
    print("  [1/8] Already applied: assistant content as string")
elif 'return { type: "text", text: sanitizeSurrogates(b.text) }' in code:
    # Find the exact if/else block and replace regardless of indentation
    pattern = re.compile(
        r'([ \t]*)(// GitHub Copilot requires.*?\n\s*// Sending as array.*?\n\s*)?'
        r'if \(model\.provider === "github-copilot"\) \{\n'
        r'\s*assistantMsg\.content = nonEmptyTextBlocks\.map\(\(b\) => sanitizeSurrogates\(b\.text\)\)\.join\(""\);\n'
        r'\s*\}\n'
        r'\s*else \{\n'
        r'\s*assistantMsg\.content = nonEmptyTextBlocks\.map\(\(b\) => \{\n'
        r'\s*return \{ type: "text", text: sanitizeSurrogates\(b\.text\) \};\n'
        r'\s*\}\);\n'
        r'\s*\}'
    )
    match = pattern.search(code)
    if match:
        indent = match.group(1)
        replacement = (
            f'{indent}// Send assistant content as a plain string for all providers.\n'
            f'{indent}// Array format [{{"type":"text","text":"..."}}] causes some models\n'
            f'{indent}// (DeepSeek, etc.) to mimic the JSON structure in their responses.\n'
            f'{indent}// String content is always valid for text-only messages in the OpenAI API.\n'
            f'{indent}assistantMsg.content = nonEmptyTextBlocks.map((b) => sanitizeSurrogates(b.text)).join("");'
        )
        code = code[:match.start()] + replacement + code[match.end():]
        changed = True
        print("  [1/8] Applied: assistant content as string")
    else:
        print("  [1/8] WARNING: Found array format but regex didn't match — patch manually")
else:
    print("  [1/8] WARNING: Could not find assistant content pattern to patch")

# ============================================================
# PATCH 2+3: Empty tool call filter + reasoning→text fallback
# ============================================================
# Inserted right after the final `finishCurrentBlock(currentBlock);`
# in the streaming response handler (the one NOT inside a nested if/for).

FILTER_MARKER = '// Filter out invalid/empty tool calls'
FALLBACK_PATCH = '''            // Filter out invalid/empty tool calls (e.g. NVIDIA GLM-5 sometimes sends
            // tool_calls with empty id/name that cause "Tool not found" errors)
            output.content = output.content.filter(b => {
                if (b.type === "toolCall" && (!b.name || b.name.trim() === "")) return false;
                return true;
            });
            // Fallback: if model returned only reasoning_content (no text, no tool calls),
            // promote thinking to text so the user sees a response (NVIDIA GLM-4.7, Kimi K2.5)
            // Skip promotion for models with reasoning=true — their thinking is genuine
            // chain-of-thought, not a misplaced answer (e.g., local llama with reasoning_content)
            const hasTextBlock = output.content.some(b => b.type === "text" && b.text && b.text.length > 0);
            const hasToolCall = output.content.some(b => b.type === "toolCall");
            if (!hasTextBlock && !hasToolCall && !model.reasoning) {
                const thinkingBlock = output.content.find(b => b.type === "thinking" && b.thinking && b.thinking.length > 0);
                if (thinkingBlock) {
                    const textBlock = { type: "text", text: thinkingBlock.thinking };
                    output.content.push(textBlock);
                    stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
                    stream.push({ type: "text_delta", contentIndex: output.content.length - 1, delta: textBlock.text, partial: output });
                }
            }'''

if FILTER_MARKER in code:
    print("  [2/8] Already applied: empty tool call filter")
    print("  [3/8] Already applied: reasoning→text fallback")
else:
    # Find the last finishCurrentBlock that's followed by signal/aborted check
    # This is the one at the end of the main streaming loop
    # Match any indentation level (12 or 16 spaces) for cross-version compat
    pattern = r'([ \t]+finishCurrentBlock\(currentBlock\);\n)([ \t]+if \(options\?\.signal\?\.aborted\))'
    match = re.search(pattern, code)
    if match:
        insertion_point = match.start() + len(match.group(1))
        code = code[:insertion_point] + FALLBACK_PATCH + '\n' + code[insertion_point:]
        changed = True
        print("  [2/8] Applied: empty tool call filter")
        print("  [3/8] Applied: reasoning→text fallback")
    else:
        print("  [2/8] WARNING: Could not find insertion point for filter/fallback")
        print("  [3/8] WARNING: (same)")

# ============================================================
# PATCH 4: 120s per-request timeout on OpenAI client
# ============================================================
# Add timeout: 120000 to the new OpenAI({...}) constructor

TIMEOUT_MARKER = 'timeout: 120000'

if TIMEOUT_MARKER in code:
    print("  [4/8] Already applied: 120s timeout")
else:
    # Try both old and new OpenAI constructor formats
    old_client_v1 = '''dangerouslyAllowBrowser: true,
        defaultHeaders: headers,
    });'''
    new_client_v1 = '''dangerouslyAllowBrowser: true,
        defaultHeaders: headers,
        timeout: 120000,
    });'''
    if old_client_v1 in code:
        code = code.replace(old_client_v1, new_client_v1)
        changed = True
        print("  [4/8] Applied: 120s timeout")
    else:
        # 0.53.0+: constructor may use different formatting
        timeout_pattern = re.compile(r'(new OpenAI\(\{[^}]*?)(defaultHeaders:\s*headers,\s*\n\s*\}\))')
        tmatch = timeout_pattern.search(code)
        if tmatch:
            code = code[:tmatch.start(2)] + 'defaultHeaders: headers,\n        timeout: 120000,\n    })' + code[tmatch.end(2):]
            changed = True
            print("  [4/8] Applied: 120s timeout (v2 format)")
        else:
            print("  [4/8] WARNING: Could not find OpenAI client constructor to patch")

# ============================================================
# PATCH 5: Kimi K2.5 tool call ID normalization
# ============================================================
# Kimi K2.5 expects tool_call IDs in `functions.name:idx` format.
# Non-standard IDs (like call_xxx) cause 4x lower tool call success.
# Source: vLLM blog "Chasing 100% Accuracy with Kimi K2" (2025/10/28)
# We normalize IDs in outbound messages when the model contains "kimi".

KIMI_MARKER = '// Normalize tool_call IDs for Kimi K2.x compatibility'

if KIMI_MARKER in code:
    print("  [5/8] Already applied: Kimi tool call ID normalization")
else:
    # Insert before the final `return { params }` or after tool_calls mapping
    # We add a post-processing step that rewrites IDs for Kimi models
    kimi_patch = '''
            // Normalize tool_call IDs for Kimi K2.x compatibility
            // Kimi expects IDs in "functions.name:idx" format; non-standard IDs
            // cause ~4x lower tool call success rate (vLLM blog, Oct 2025).
            if (model.id && model.id.toLowerCase().includes("kimi")) {
                let kimiToolIdx = 0;
                for (const p of params) {
                    if (p.role === "assistant" && p.tool_calls) {
                        for (const tc of p.tool_calls) {
                            const fname = tc.function?.name || "unknown";
                            tc.id = "functions." + fname + ":" + kimiToolIdx;
                            kimiToolIdx++;
                        }
                    }
                    if (p.role === "tool" && p.tool_call_id) {
                        // Find matching assistant tool_call to get normalized ID
                        for (const prev of params) {
                            if (prev.role === "assistant" && prev.tool_calls) {
                                for (const tc of prev.tool_calls) {
                                    const fname = tc.function?.name || "";
                                    if (p.tool_call_id === tc.id || p.name === fname) {
                                        p.tool_call_id = tc.id;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }'''

    # Insert right before `return params;` in convertMessages()
    # Use a unique anchor: the for-loop end + return that only appears in convertMessages()
    insert_target = '        lastRole = msg.role;\n    }\n    return params;\n}'
    if insert_target in code:
        code = code.replace(insert_target, '        lastRole = msg.role;\n    }\n' + kimi_patch + '\n    return params;\n}', 1)
        changed = True
        print("  [5/8] Applied: Kimi tool call ID normalization")
    else:
        print("  [5/8] WARNING: Could not find insertion point for Kimi patch")

# ============================================================
# PATCH 6: Text-to-tool-call fallback parser
# ============================================================
# Some models (DeepSeek on NIM) output tool calls as JSON text
# in the content field instead of the structured tool_calls field.
# This adds a regex fallback that extracts tool calls from text.
# Source: NVIDIA Developer Forums, Roo-Code Issue #10349

TEXTPARSE_MARKER = '// Fallback: extract tool calls from text content'

if TEXTPARSE_MARKER in code:
    print("  [6/8] Already applied: text-to-tool-call fallback parser")
else:
    textparse_patch = '''            // Fallback: extract tool calls from text content when model outputs
            // tool calls as JSON text instead of structured tool_calls field.
            // Common with DeepSeek on NVIDIA NIM and some other open models.
            if (!hasToolCall && hasTextBlock) {
                const allText = output.content
                    .filter(b => b.type === "text")
                    .map(b => b.text)
                    .join("");
                // Match JSON patterns like {"name":"func","arguments":{...}} or
                // {"tool_call":"func","arguments":{...}} in the text output
                const toolJsonPattern = /\\{\\s*(?:"(?:name|tool_call|function)"\\s*:\\s*"([^"]+)"\\s*,\\s*"(?:arguments|parameters)"\\s*:\\s*(\\{[^}]*\\})|"(?:arguments|parameters)"\\s*:\\s*(\\{[^}]*\\})\\s*,\\s*"(?:name|tool_call|function)"\\s*:\\s*"([^"]+)")\\s*\\}/g;
                let toolMatch;
                let extractedTools = [];
                while ((toolMatch = toolJsonPattern.exec(allText)) !== null) {
                    const funcName = toolMatch[1] || toolMatch[4];
                    const funcArgs = toolMatch[2] || toolMatch[3];
                    if (funcName && context.tools?.some(t => t.name === funcName)) {
                        try {
                            const parsedArgs = JSON.parse(funcArgs);
                            extractedTools.push({
                                type: "toolCall",
                                id: "extracted_" + funcName + "_" + extractedTools.length,
                                name: funcName,
                                arguments: parsedArgs,
                            });
                        } catch(e) { /* skip unparseable */ }
                    }
                }
                // Also match GLM-style XML: <tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value>...</tool_call>
                if (extractedTools.length === 0) {
                    const xmlToolPattern = /<tool_call>\\s*(\\w+)((?:<arg_key>[\\s\\S]*?<\\/arg_key>\\s*<arg_value>[\\s\\S]*?<\\/arg_value>\\s*)+)<\\/tool_call>/g;
                    const xmlArgPattern = /<arg_key>([\\s\\S]*?)<\\/arg_key>\\s*<arg_value>([\\s\\S]*?)<\\/arg_value>/g;
                    let xmlMatch;
                    while ((xmlMatch = xmlToolPattern.exec(allText)) !== null) {
                        const funcName = xmlMatch[1].trim();
                        if (!funcName || !context.tools?.some(t => t.name === funcName)) continue;
                        const argsBlock = xmlMatch[2];
                        const args = {};
                        let argMatch;
                        while ((argMatch = xmlArgPattern.exec(argsBlock)) !== null) {
                            args[argMatch[1].trim()] = argMatch[2].trim();
                        }
                        xmlArgPattern.lastIndex = 0;
                        extractedTools.push({
                            type: "toolCall",
                            id: "extracted_xml_" + funcName + "_" + extractedTools.length,
                            name: funcName,
                            arguments: args,
                        });
                    }
                }
                if (extractedTools.length > 0) {
                    // Replace text content with extracted tool calls
                    output.content = output.content.filter(b => b.type !== "text");
                    for (const tc of extractedTools) {
                        output.content.push(tc);
                        stream.push({ type: "tool_call_start", contentIndex: output.content.length - 1, partial: output });
                    }
                }
            }'''

    # Insert after the reasoning→text fallback block (after the closing `}` of that block)
    reasoning_end = "                }\n            }\n            if (options?.signal?.aborted)"
    if reasoning_end in code:
        code = code.replace(reasoning_end, "                }\n            }\n" + textparse_patch + "\n            if (options?.signal?.aborted)", 1)
        changed = True
        print("  [6/8] Applied: text-to-tool-call fallback parser")
    else:
        print("  [6/8] WARNING: Could not find insertion point for text-to-tool-call parser")

# ============================================================
# PATCH 7: Strip reasoning_content from historical messages
# ============================================================
# DeepSeek docs explicitly say reasoning_content from previous
# turns should NOT be included in context. Including it causes:
# (a) 30-60% extra token waste, (b) format contamination where
# the model mimics the reasoning format in output.
# Source: DeepSeek API docs (thinking_mode), OpenCode Issue #5577

STRIP_MARKER = '// Strip reasoning_content from historical assistant messages'

if STRIP_MARKER in code:
    print("  [7/8] Already applied: strip reasoning_content from history")
else:
    strip_patch = '''        // Strip reasoning_content from historical assistant messages.
        // DeepSeek docs state CoT from previous turns should NOT be sent.
        // Including it wastes 30-60% tokens and causes format contamination.
        for (const p of params) {
            if (p.role === "assistant") {
                delete p.reasoning_content;
                delete p.reasoning_details;
            }
        }'''

    # Insert right before the last `return params;` before convertTools/export
    # Try literal anchors that preserve surrounding declarations
    target_a = '    return params;\n}\nfunction convertTools'
    target_b = '    return params;\n}\nexport {'
    for target in [target_a, target_b]:
        if target in code:
            suffix = target[len('    return params;\n}\n'):]
            code = code.replace(target, strip_patch + '\n    return params;\n}\n' + suffix, 1)
            changed = True
            print("  [7/8] Applied: strip reasoning_content from history")
            break
    else:
        print("  [7/8] WARNING: Could not find insertion point for reasoning strip")

# ============================================================
# PATCH 8: Global API key fallback for custom providers
# ============================================================
# When OpenClaw resolves API keys for custom providers (nvidia-qwen, etc.)
# via authStorage.setRuntimeApiKey(), the key is injected through the
# pi-coding-agent SDK wrapper. However, if options.apiKey is lost due to
# race conditions or stale runtime snapshots, streamSimpleOpenAICompletions
# throws "No API key for provider: <name>" because getEnvApiKey() has no
# mapping for custom providers. This patch adds a fallback that checks
# globalThis.__openclawResolvedApiKeys (populated by AuthStorage.getApiKey)
# before throwing.

GLOBAL_FALLBACK_MARKER = '// Fallback: check OpenClaw global resolved API keys'

if GLOBAL_FALLBACK_MARKER in code:
    print("  [8/8] Already applied: global API key fallback")
else:
    old_apikey_line = 'const apiKey = options?.apiKey || getEnvApiKey(model.provider);'
    new_apikey_line = '''const apiKey = options?.apiKey || getEnvApiKey(model.provider)
        // Fallback: check OpenClaw global resolved API keys for custom providers
        // (nvidia-qwen, nvidia-glm, etc.) that have no env var mapping in pi-ai.
        || globalThis.__openclawResolvedApiKeys?.[model.provider];'''
    if old_apikey_line in code:
        code = code.replace(old_apikey_line, new_apikey_line, 1)
        changed = True
        print("  [8/8] Applied: global API key fallback")
    else:
        print("  [8/8] WARNING: Could not find apiKey resolution line to patch")

if changed:
    with open(filepath, 'w') as f:
        f.write(code)
    print(f"  DONE — file written")
else:
    print(f"  SKIP — all patches already applied")

# Signal to shell: 0 = patched, 2 = already patched
sys.exit(0 if changed else 2)
PYTHON_PATCH

    rc=$?
    set -e
    if [ $rc -eq 0 ]; then
        PATCHED=$((PATCHED + 1))
    else
        SKIPPED=$((SKIPPED + 1))
    fi
    echo ""
done

echo "=== Summary: $PATCHED patched, $SKIPPED already up-to-date ==="
