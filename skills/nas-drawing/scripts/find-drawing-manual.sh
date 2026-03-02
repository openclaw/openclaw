#!/bin/bash
# NAS 图纸手动查询 - 完整流程，稳定但较慢（15-20 秒）
# Usage: ./find-drawing-manual.sh <图纸编号> <企业微信用户 ID>

QUERY="$1"
USER="$2"

if [ -z "$QUERY" ] || [ -z "$USER" ]; then
    echo "用法：$0 <图纸编号> <用户 ID>"
    exit 1
fi

echo "🔍 手动查询 $QUERY..."

# 使用 Python 执行完整的 NAS 查询流程
python3 << 'PYTHON_SCRIPT'
import socket
import json
import urllib.parse
import time
import sys
import os

QUERY = sys.argv[1] if len(sys.argv) > 1 else ""
USER = sys.argv[2] if len(sys.argv) > 2 else ""

def nas_request(path, sid=None):
    """发送 NAS HTTP 请求"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(15)
    sock.connect(('192.168.3.106', 5000))
    
    url = path
    if sid:
        url += f"&_sid={sid}" if "?" in url else f"?_sid={sid}"
    
    request = f'GET {url} HTTP/1.1\r\nHost: 192.168.3.106:5000\r\nConnection: close\r\n\r\n'
    sock.sendall(request.encode())
    
    response = b''
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            break
        response += chunk
    sock.close()
    
    # 解析响应
    body = response.decode('utf-8', errors='ignore').split('\r\n\r\n', 1)[1]
    # 处理 chunked encoding
    if '\n' in body:
        lines = body.split('\n')
        for line in lines:
            if line.strip() and ('{' in line):
                try:
                    return json.loads(line)
                except:
                    pass
    return {}

# Step 1: 登录
print("Step 1: 登录 NAS...")
login_data = nas_request('/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=login&account=openclaw&passwd=&session=FileStation&format=cookie')
sid = login_data.get('data', {}).get('sid')
if not sid:
    print("❌ 登录失败")
    sys.exit(1)

# Step 2: 搜索
print(f"Step 2: 搜索 {QUERY}...")
folder_path = urllib.parse.quote('/公司产品图档', safe='')
pattern = urllib.parse.quote(f'*{QUERY}*', safe='')
search_data = nas_request(f'/webapi/entry.cgi?api=SYNO.FileStation.Search&version=2&method=start&folder_path={folder_path}&pattern={pattern}&recursive=true', sid)
taskid = search_data.get('data', {}).get('taskid')
if not taskid:
    print("❌ 搜索启动失败")
    sys.exit(1)

# Step 3: 等待结果
print("Step 3: 等待搜索结果...")
for i in range(5):
    time.sleep(2)
    result_data = nas_request(f'/webapi/entry.cgi?api=SYNO.FileStation.Search&version=2&method=list&taskid={taskid}&offset=0&limit=20&additional=%5B%22real_path%22%5D', sid)
    files = result_data.get('data', {}).get('files', [])
    if files:
        break

if not files:
    print("❌ 未找到文件")
    sys.exit(1)

# Step 4: 选择文件（优先 .jpg）
target_file = None
for f in files:
    if f['name'].endswith('.jpg'):
        target_file = f
        break
if not target_file:
    for f in files:
        if f['name'].endswith('.dwg'):
            target_file = f
            break
if not target_file:
    target_file = files[0]

file_path = target_file['path']
file_name = target_file['name']
file_ext = file_name.split('.')[-1]

print(f"Step 4: 下载 {file_name}...")

# Step 5: 下载文件
encoded_path = urllib.parse.quote(file_path, safe='')
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.settimeout(30)
sock.connect(('192.168.3.106', 5000))

request = f'GET /webapi/entry.cgi?api=SYNO.FileStation.Download&version=2&method=download&path={encoded_path}&mode=download&_sid={sid} HTTP/1.1\r\nHost: 192.168.3.106:5000\r\nConnection: close\r\n\r\n'
sock.sendall(request.encode())

# 读取响应头
response = b''
while b'\r\n\r\n' not in response:
    chunk = sock.recv(4096)
    if not chunk:
        break
    response += chunk

# 保存文件
tmp_file = f'/tmp/{QUERY}.{file_ext}'
with open(tmp_file, 'wb') as f:
    body_start = response.find(b'\r\n\r\n') + 4
    f.write(response[body_start:])
    
    while True:
        chunk = sock.recv(65536)
        if not chunk:
            break
        f.write(chunk)

sock.close()
print(f"✅ 下载完成: {tmp_file}")

# Step 6: 发送企业微信
print(f"Step 5: 发送给 {USER}...")
os.system(f'node ~/openclaw/skills/wecom-file-send/scripts/send-file.cjs "{USER}" "{tmp_file}" "📐 {QUERY} 图纸 - 来自 NAS 公司产品图档"')

PYTHON_SCRIPT "$QUERY" "$USER"
