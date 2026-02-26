#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/jack/github/openclaw/.openclaw/army"
RUNTIME="$ROOT/runtime"
DRAFTS="$ROOT/drafts"
CHAT_TARGET="chat_id:14886"

mkdir -p "$RUNTIME" "$DRAFTS"

ts="$(date +%Y%m%d-%H%M%S)"
id="xhs-${ts}"
out_json="$DRAFTS/${id}.json"
out_md="$DRAFTS/${id}.md"

prompt='只输出严格JSON对象，不要markdown和解释。字段：title(字符串),content(字符串),tags(字符串数组,10-15个)。主题：晚间30分钟亲子陪伴减负。受众仅家长/监护人，不得直接劝导儿童，不得绝对化承诺。'

raw="$(openclaw agent --agent mydazy-commander --message "$prompt" --thinking low --timeout 120 --json 2>/dev/null || true)"
text="$(printf '%s' "$raw" | jq -r '.reply.text // .text // empty' 2>/dev/null || true)"

if [[ -z "$text" ]]; then
  text="$raw"
fi

json_line="$(printf '%s' "$text" | jq -Rr 'fromjson? // empty' | head -n 1)"

if [[ -z "$json_line" ]]; then
  json_line='{"title":"下班很累也能完成的30分钟亲子陪伴模板","content":"下班后没精力，不代表陪伴只能放弃。我们把晚间流程固定成30分钟：5分钟情绪对齐、10分钟共读、10分钟互动问答、5分钟安抚收尾。目标不是完美，而是稳定可持续，帮助家长减轻执行压力。","tags":["亲子陪伴","家庭教育","双职工家庭","睡前仪式","育儿日常","亲子沟通","3到8岁","高质量陪伴","家长成长","育儿经验"]}'
fi

printf '%s\n' "$json_line" | jq '.' > "$out_json"

{
  echo "# XHS Draft $id"
  echo
  echo "## 标题"
  jq -r '.title' "$out_json"
  echo
  echo "## 正文"
  jq -r '.content' "$out_json"
  echo
  echo "## 标签"
  jq -r '.tags | map("#" + (. | gsub("^#"; ""))) | join(" ")' "$out_json"
} > "$out_md"

printf '{"id":"%s","status":"pending_review","json":"%s","md":"%s","created_at":"%s"}\n' \
  "$id" "$out_json" "$out_md" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$RUNTIME/xhs_queue.jsonl"

msg="XHS待审核草稿已生成：$id\n请回复：同意发布 $id\n如需修改回复：驳回 $id + 原因"
openclaw message send --channel imessage --target "$CHAT_TARGET" --message "$msg" --json >/dev/null

echo "generated:$id"
