#!/bin/bash
# Curator Image Analysis Tool
# 用法: ./analyze-image.sh <image_url>
# 輸出: JSON 格式的視覺分析結果

set -e

IMAGE_URL="$1"
TEMP_DIR="/tmp/curator_images"
IMAGE_FILE="$TEMP_DIR/$(date +%s).png"

if [ -z "$IMAGE_URL" ]; then
    echo '{"error": "Missing image_url parameter"}' >&2
    exit 1
fi

# 建立臨時目錄
mkdir -p "$TEMP_DIR"

# 下載圖片
curl -s -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
    -o "$IMAGE_FILE" "$IMAGE_URL"

if [ ! -f "$IMAGE_FILE" ]; then
    echo '{"error": "Failed to download image"}' >&2
    exit 1
fi

# 調用 Claude Code 分析圖片
# 輸出 JSON 格式結果
echo "{\"image_path\": \"$IMAGE_FILE\", \"status\": \"downloaded\"}"
