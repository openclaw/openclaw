#!/usr/bin/env bash
# Test structured-memory classification prompt against local Ollama models.
# Usage: bash scripts/test-classification.sh [model]
#   model defaults to "gemma3:27b", pass "qwen2.5:7b" to test the other.
# Requires: curl, jq (optional, for pretty-printing)

set -euo pipefail

OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
MODEL="${1:-gemma3:27b}"
TIMEOUT_S="${2:-30}"

# --------------- classification prompt (same as tools.ts) ---------------
PROMPT_PREFIX='You are a memory classification assistant. Analyze the following text and classify it into a structured memory record.

Classify into ONE of these types:
- fact: A factual statement or piece of knowledge
- event: Something that happened at a point in time
- plan: A future intention, goal, or plan
- impression: A subjective opinion, feeling, or assessment
- preference: A stated like, dislike, or preference
- rule: A conditional rule or constraint

Assign an importance score (1-10) where:
10 = Critical, must remember (identity, core goals, safety rules)
7-9 = Very important (key preferences, recurring patterns)
4-6 = Moderately important (contextual details)
1-3 = Minor (trivia, passing remarks)

Assign a confidence score (0.0-1.0) based on how clearly the text conveys this information.

Also refine the summary to be concise (100 chars or fewer) and extract key space-separated lowercase keywords.

Respond ONLY with a valid JSON object with these fields:
{
  "type": "<one of: fact, event, plan, impression, preference, rule>",
  "importance": <integer 1-10>,
  "confidence": <number 0.0-1.0>,
  "summary_refined": "<concise summary, 100 chars max>",
  "keywords": "<space-separated lowercase keywords>"
}

Text to classify:'

# --------------- test cases ---------------
declare -A CASES
CASES=(
  ["fact-identity"]="用户的名字是张三，生日是3月14日，住在北京朝阳区。"
  ["fact-knowledge"]="我们公司的核心产品是一个AI编码助手，支持20多种编程语言。"
  ["event-meeting"]="上周五下午2点，我和李四在星巴克讨论了Q3的发布计划，王五也参加了。"
  ["event-incident"]="昨天晚上10点生产环境数据库挂了，持续了45分钟才恢复。"
  ["plan-deadline"]="下周三之前需要完成Q2预算报告的初稿，交给财务审核。"
  ["plan-intention"]="我计划今年秋天去日本旅行，大概两周时间，重点去京都和北海道。"
  ["impression-positive"]="我觉得新来的CTO技术视野很强，对AI infra的理解很深。"
  ["impression-negative"]="最近团队的氛围不太好，大家都很疲惫，我感觉是Deadline压得太紧了。"
  ["preference-tech"]="我不喜欢用Python写后端服务，性能和类型安全都不如Go。"
  ["preference-work"]="在工具选择上我更倾向轻量级的方案，不喜欢引入太重的框架。"
  ["rule-company"]="所有对外的正式合同都必须经过法务部门审核后才能发出。"
  ["rule-process"]="代码合并到main分支之前，必须通过CI的全部测试并且至少有一个同事的Code Review。"
  ["edge-ambiguous"]="嗯，差不多吧，我觉得还行，没什么特别的。"
  ["edge-multi"]="我下周要去上海出差三天，顺便找老同学吃个饭，然后周五之前把那个爬虫脚本写完。"
)

PASS=0
FAIL=0
RESULTS=""

echo "============================================"
echo " Model : $MODEL"
echo " Cases : ${#CASES[@]}"
echo "============================================"
echo ""

for case_id in "${!CASES[@]}"; do
  text="${CASES[$case_id]}"
  full_prompt="${PROMPT_PREFIX} ${text}"

  echo "── ${case_id} ──"
  echo "  input : ${text}"

  # escape the prompt for JSON embedding
  json_prompt=$(jq -Rs '.' <<<"$full_prompt" 2>/dev/null || printf '%s' "$full_prompt" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null)

  if [ -z "${json_prompt:-}" ]; then
    echo "  SKIP  : jq / python3 not available for JSON escaping"
    continue
  fi

  # call ollama chat API
  resp=$(curl -s --max-time "$TIMEOUT_S" "$OLLAMA_URL/api/chat" \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"$MODEL\",
      \"stream\": false,
      \"options\": { \"temperature\": 0.0 },
      \"messages\": [{\"role\": \"user\", \"content\": $json_prompt}]
    }" 2>&1) || {
    echo "  ERROR : curl failed / timeout"
    FAIL=$((FAIL + 1))
    continue
  }

  # extract content from response
  reply=$(echo "$resp" | jq -r '.message.content // empty' 2>/dev/null)
  if [ -z "$reply" ]; then
    # try python3 extraction
    reply=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',{}).get('content',''))" 2>/dev/null || echo "")
  fi

  if [ -z "$reply" ]; then
    echo "  ERROR : empty response"
    echo "  raw   : $(echo "$resp" | head -c 200)"
    FAIL=$((FAIL + 1))
    continue
  fi

  # try to extract JSON from reply
  classification=$(echo "$reply" | jq -c '.' 2>/dev/null)
  if [ -z "$classification" ]; then
    # try regex extraction (same as parseClassificationResponse)
    json_part=$(echo "$reply" | grep -oP '\{[\s\S]*\}' | head -1)
    classification=$(echo "$json_part" | jq -c '.' 2>/dev/null || echo "")
  fi

  if [ -z "$classification" ]; then
    # try python3 extraction
    classification=$(echo "$reply" | python3 -c "
import sys, re, json
raw = sys.stdin.read()
m = re.search(r'\{[\s\S]*\}', raw)
if m:
    try:
        obj = json.loads(m.group())
        print(json.dumps(obj))
    except: pass
" 2>/dev/null || echo "")
  fi

  # validate fields
  is_valid=false
  if [ -n "$classification" ]; then
    v_type=$(echo "$classification" | jq -r '.type // empty' 2>/dev/null)
    v_importance=$(echo "$classification" | jq -r '.importance // empty' 2>/dev/null)
    v_confidence=$(echo "$classification" | jq -r '.confidence // empty' 2>/dev/null)
    v_summary=$(echo "$classification" | jq -r '.summary_refined // empty' 2>/dev/null)
    v_keywords=$(echo "$classification" | jq -r '.keywords // empty' 2>/dev/null)

    valid_types="fact event plan impression preference rule"
    if [ -n "$v_type" ] && echo "$valid_types" | grep -qw "$v_type" && \
       [ -n "$v_importance" ] && [ "$v_importance" -ge 1 ] 2>/dev/null && [ "$v_importance" -le 10 ] 2>/dev/null && \
       [ -n "$v_confidence" ] && \
       [ -n "$v_summary" ] && [ -n "$v_keywords" ]; then
      is_valid=true
    fi

    echo "  output: ${classification}"
    if [ "$is_valid" = true ]; then
      echo "  PASS  : type=$v_type imp=$v_importance conf=$v_confidence"
      PASS=$((PASS + 1))
    else
      echo "  FAIL  : invalid/missing fields"
      echo "  raw   : $(echo "$reply" | head -c 200)"
      FAIL=$((FAIL + 1))
    fi
  else
    echo "  FAIL  : could not parse JSON"
    echo "  raw   : $(echo "$reply" | head -c 200)"
    FAIL=$((FAIL + 1))
  fi

  echo ""
done

echo "============================================"
echo " $MODEL  →  PASS: $PASS  FAIL: $FAIL  (of ${#CASES[@]})"
echo "============================================"
