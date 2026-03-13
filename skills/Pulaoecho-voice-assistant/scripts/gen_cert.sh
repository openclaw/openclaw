#!/bin/bash
# 生成自签名 TLS 证书，用于 WSS 模式
# 用法: bash gen_cert.sh [输出目录]  (默认: ~/.openclaw/certs)

set -e

# 首先保存到技能目录
SKILL_CERT_DIR="$(dirname "$(dirname "$0")")/certs"
mkdir -p "$SKILL_CERT_DIR"

# 然后拷贝到默认目录
CERT_DIR="${1:-$HOME/.openclaw/certs}"
mkdir -p "$CERT_DIR"

CERT="$SKILL_CERT_DIR/server.crt"
KEY="$SKILL_CERT_DIR/server.key"

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
    echo "证书已存在: $CERT"
    echo "如需重新生成，请先删除旧文件再运行此脚本。"
    exit 0
fi

# 获取本机局域网 IP
LOCAL_IP=$(ipconfig getifaddr en1 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "")

# 构建 SAN：基础 + 本机 IP + 额外 IP（EXTRA_IPS 逗号分隔，例如 frp 公网 IP）
SAN="IP:127.0.0.1,DNS:localhost"
if [ -n "$LOCAL_IP" ] && [ "$LOCAL_IP" != "127.0.0.1" ]; then
    SAN="$SAN,IP:$LOCAL_IP"
fi
if [ -n "$EXTRA_IPS" ]; then
    for IP in $(echo "$EXTRA_IPS" | tr ',' ' '); do
        SAN="$SAN,IP:$IP"
    done
fi

echo "生成自签名证书..."
echo "  输出目录: $CERT_DIR"
echo "  SAN:      $SAN"

openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$KEY" \
    -out "$CERT" \
    -days 3650 \
    -subj "/CN=pulaoecho-voice-assistant" \
    -addext "subjectAltName=$SAN"

chmod 600 "$KEY"
chmod 644 "$CERT"

# 拷贝到默认目录
echo ""
echo "正在拷贝证书到默认目录: $CERT_DIR"
cp "$CERT" "$CERT_DIR/"
cp "$KEY" "$CERT_DIR/"
chmod 600 "$CERT_DIR/server.key"
chmod 644 "$CERT_DIR/server.crt"

echo ""
echo "✅ 证书生成完成"
echo "   证书: $CERT"
echo "   私钥: $KEY"
echo "   同时已拷贝到: $CERT_DIR"
echo "   有效期: 10年"
echo ""
echo "启用 WSS：在 config.json 中设置 server.tls.enabled = true"
echo ""
echo "嵌入式设备端需要信任此证书（或在代码中跳过证书验证）。"
echo "导出证书（复制到设备）："
echo "  cat $CERT"
