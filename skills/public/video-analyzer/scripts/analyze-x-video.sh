#!/bin/bash
#
# X 视频推文解读方案
# 工作流程：下载视频 → 提取音频 → 语音识别 → 文字总结
#

set -e

# 配置
DOWNLOAD_DIR="${HOME}/.openclaw/workspace/media/x-videos"
MAX_DURATION=600  # 最大处理 10 分钟视频

# 显示用法
usage() {
    echo "用法: $0 <x-post-url>"
    echo ""
    echo "示例: $0 https://x.com/username/status/1234567890"
    exit 1
}

# 检查参数
if [ $# -eq 0 ]; then
    usage
fi

URL="$1"
mkdir -p "$DOWNLOAD_DIR"

echo "🎬 X 视频推文解读"
echo "=================="
echo ""

# 步骤 1: 获取推文文字 (Jina Reader)
echo "📄 步骤 1: 获取推文文字..."
TWEET_TEXT=$(curl -s "https://r.jina.ai/${URL}" -H "X-Return-Format: text" 2>/dev/null || echo "")

if [ -n "$TWEET_TEXT" ]; then
    echo "✅ 推文文字获取成功"
    echo ""
    echo "--- 推文内容 ---"
    echo "$TWEET_TEXT" | head -20
    echo "----------------"
    echo ""
else
    echo "⚠️  无法获取推文文字，继续尝试下载视频..."
fi

# 步骤 2: 下载视频
echo ""
echo "📥 步骤 2: 下载视频..."
cd "$DOWNLOAD_DIR"

# 使用 yt-dlp 下载
VIDEO_FILE=$(yt-dlp \
    --no-warnings \
    --no-check-certificate \
    -f "best[ext=mp4]/best" \
    -o "%(id)s.%(ext)s" \
    --print filename \
    "$URL" 2>/dev/null || echo "")

if [ -z "$VIDEO_FILE" ] || [ ! -f "$VIDEO_FILE" ]; then
    echo "❌ 视频下载失败"
    echo ""
    echo "可能的原因:"
    echo "  - X 视频有额外保护"
    echo "  - 链接不是公开视频"
    echo "  - yt-dlp 需要更新: yt-dlp -U"
    exit 1
fi

echo "✅ 视频下载成功: $VIDEO_FILE"

# 检查视频时长
DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$VIDEO_FILE" 2>/dev/null | cut -d. -f1)
echo "⏱️  视频时长: ${DURATION}s"

if [ "$DURATION" -gt "$MAX_DURATION" ]; then
    echo "⚠️  视频超过 ${MAX_DURATION}s，只处理前 ${MAX_DURATION}s"
    DURATION=$MAX_DURATION
fi

# 步骤 3: 提取音频
echo ""
echo "🎵 步骤 3: 提取音频..."
AUDIO_FILE="${VIDEO_FILE%.*}.mp3"

ffmpeg -i "$VIDEO_FILE" -vn -ar 16000 -ac 1 -b:a 32k -t "$MAX_DURATION" "$AUDIO_FILE" -y 2>/dev/null

if [ ! -f "$AUDIO_FILE" ]; then
    echo "❌ 音频提取失败"
    exit 1
fi

echo "✅ 音频提取成功: $AUDIO_FILE"

# 步骤 4: 语音识别 (Whisper)
echo ""
echo "🗣️ 步骤 4: 语音识别..."

echo "正在使用 Whisper 转录..."
echo "(首次使用会自动下载模型，可能需要几分钟)"
echo ""

# 检查 whisper 是否安装
WHISPER_BIN="/Library/Frameworks/Python.framework/Versions/3.13/bin/whisper"
if ! command -v whisper &> /dev/null && [ ! -f "$WHISPER_BIN" ]; then
    echo "⚠️  Whisper 未安装"
    echo ""
    echo "安装方法:"
    echo "  pip3 install openai-whisper"
    echo ""
    echo "或者使用系统自带的语音识别:"
    echo "  1. macOS: 使用 say 命令 (仅限英文)"
    echo "  2. 其他: 需要手动安装 whisper"
    echo ""
    echo "音频文件已保存: $AUDIO_FILE"
    echo "你可以用其他工具转录后再发给我"
    exit 0
fi

# 如果 whisper 不在 PATH，使用完整路径
if ! command -v whisper &> /dev/null; then
    WHISPER_CMD="$WHISPER_BIN"
else
    WHISPER_CMD="whisper"
fi

# 运行 whisper
TRANSCRIPT=$($WHISPER_CMD "$AUDIO_FILE" --model small --language Chinese --output_format txt 2>/dev/null | head -100 || echo "")

if [ -n "$TRANSCRIPT" ]; then
    echo "✅ 语音识别完成"
    echo ""
    echo "--- 视频转录内容 ---"
    echo "$TRANSCRIPT"
    echo "--------------------"
else
    echo "⚠️  语音识别失败或没有检测到语音"
fi

# 清理临时文件 (可选)
# rm -f "$VIDEO_FILE" "$AUDIO_FILE"

echo ""
echo "✨ 处理完成!"
echo ""
echo "文件保存位置:"
echo "  视频: $VIDEO_FILE"
echo "  音频: $AUDIO_FILE"
