#!/bin/bash
# NAS 图纸快速查询 - 5 秒内完成
# Usage: ./find-drawing-fast.sh <图纸编号> <企业微信用户 ID>

QUERY="$1"
USER="$2"

if [ -z "$QUERY" ] || [ -z "$USER" ]; then
    echo "用法：$0 <图纸编号> <用户 ID>"
    echo "示例：$0 B0111 WangChong"
    exit 1
fi

echo "🔍 正在查找 $QUERY..."

# Step 1: 登录 NAS
SID=$(curl -s "http://192.168.3.106:5000/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=login&account=openclaw&passwd=&session=FileStation&format=cookie" | grep -o '"sid":"[^"]*"' | cut -d'"' -f4)

if [ -z "$SID" ]; then
    echo "❌ NAS 登录失败"
    exit 1
fi

# Step 2: 启动搜索
TASK=$(curl -s "http://192.168.3.106:5000/webapi/entry.cgi?api=SYNO.FileStation.Search&version=2&method=start&folder_path=%2F%E5%85%AC%E5%8F%B8%E4%BA%A7%E5%93%81%E5%9B%BE%E6%A1%A3&pattern=*${QUERY}*&recursive=true&_sid=$SID" | grep -o '"taskid":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TASK" ]; then
    echo "❌ 搜索启动失败"
    exit 1
fi

# Step 3: 等待并获取结果（最多重试 3 次）
for i in {1..3}; do
    sleep 2
    RESULT=$(curl -s "http://192.168.3.106:5000/webapi/entry.cgi?api=SYNO.FileStation.Search&version=2&method=list&taskid=$TASK&offset=0&limit=20&additional=%5B%22real_path%22%5D&_sid=$SID")
    
    # 检查是否有结果
    if echo "$RESULT" | grep -q '"files"'; then
        break
    fi
    
    # 如果已完成但没有文件，直接退出
    if echo "$RESULT" | grep -q '"finished":true'; then
        if [ $i -eq 3 ]; then
            break
        fi
    fi
done

# Step 4: 解析结果（优先.jpg）

# 优先找.jpg，其次.dwg，再次.pdf
FILEPATH=$(echo "$RESULT" | grep -o '"path":"[^"]*\.jpg"' | head -1 | cut -d'"' -f4)
if [ -z "$FILEPATH" ]; then
    FILEPATH=$(echo "$RESULT" | grep -o '"path":"[^"]*\.dwg"' | head -1 | cut -d'"' -f4)
fi
if [ -z "$FILEPATH" ]; then
    FILEPATH=$(echo "$RESULT" | grep -o '"path":"[^"]*\.pdf"' | head -1 | cut -d'"' -f4)
fi

if [ -z "$FILEPATH" ]; then
    echo "❌ 未找到图纸：$QUERY"
    exit 1
fi

# 提取文件名
FILENAME=$(basename "$FILEPATH")
EXT="${FILENAME##*.}"

# Step 5: 下载
TMPFILE="/tmp/${QUERY}.${EXT}"
curl -s -o "$TMPFILE" "http://192.168.3.106:5000/webapi/entry.cgi?api=SYNO.FileStation.Download&version=2&method=download&path=$FILEPATH&mode=download&_sid=$SID"

if [ ! -f "$TMPFILE" ]; then
    echo "❌ 下载失败"
    exit 1
fi

# Step 6: 发送企业微信
echo "📤 正在发送给 $USER..."
node ~/openclaw/skills/wecom-file-send/scripts/send-file.cjs "$USER" "$TMPFILE" "📐 $QUERY 图纸 - 来自 NAS 公司产品图档"

echo "✅ 发送完成！"
