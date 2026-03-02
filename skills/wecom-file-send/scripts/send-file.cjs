#!/usr/bin/env node
/**
 * WeCom File Send Script
 * 通过企业微信自建应用 API 发送文件
 *
 * Usage: node send-file.js <userId> <filePath> [message]
 *
 * Examples:
 *   node send-file.js WangPengCheng /path/to/file.pdf
 *   node send-file.js WangPengCheng /path/to/file.pdf "请查收报表"
 *   node send-file.js "WangPengCheng|WangChong" /path/to/file.pdf "群发文件"
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

// 企业微信配置
const CORP_ID = "ww7cb680a3906fd115";
const AGENT_SECRET = "fgxxFND5_b7z5FH6zREldwe1Ga69HElyvBtE9K32evE";
const AGENT_ID = 1000002;

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function getAccessToken() {
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CORP_ID}&corpsecret=${AGENT_SECRET}`;
  const data = await httpsRequest(url);
  if (data.access_token) return data.access_token;
  throw new Error(`获取 access_token 失败: ${data.errmsg}`);
}

async function uploadFile(accessToken, filePath) {
  const fileName = path.basename(filePath);
  const fileContent = fs.readFileSync(filePath);
  const boundary = "----FormBoundary" + Date.now().toString(36);

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    fileContent,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const url = new URL(
    `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${accessToken}&type=file`,
  );

  const data = await httpsRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": body.length,
    },
    body,
  });

  if (data.media_id) return data.media_id;
  throw new Error(`文件上传失败: ${data.errmsg} (errcode: ${data.errcode})`);
}

async function sendTextMessage(accessToken, userId, content) {
  const url = new URL(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`,
  );
  const payload = JSON.stringify({
    touser: userId,
    msgtype: "text",
    agentid: AGENT_ID,
    text: { content },
    safe: 0,
  });

  return httpsRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
}

async function sendFileMessage(accessToken, userId, mediaId) {
  const url = new URL(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`,
  );
  const payload = JSON.stringify({
    touser: userId,
    msgtype: "file",
    agentid: AGENT_ID,
    file: { media_id: mediaId },
    safe: 0,
  });

  const data = await httpsRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });

  if (data.errcode === 0) return data;
  throw new Error(`文件发送失败: ${data.errmsg} (errcode: ${data.errcode})`);
}

async function main() {
  const [userId, filePath, message] = process.argv.slice(2);

  if (!userId || !filePath) {
    console.error("Usage: node send-file.js <userId> <filePath> [message]");
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`文件不存在: ${filePath}`);
    process.exit(1);
  }

  const fileSize = fs.statSync(filePath).size;
  const fileName = path.basename(filePath);

  try {
    // Step 1: 获取 access_token
    console.log("Step 1: 获取 access_token...");
    const accessToken = await getAccessToken();
    console.log("✅ access_token 获取成功");

    // Step 2: 发送文本消息（如果有）
    if (message) {
      console.log(`Step 2: 发送文本消息...`);
      await sendTextMessage(accessToken, userId, message);
      console.log("✅ 文本消息发送成功");
    }

    // Step 3: 上传文件
    console.log(`Step 3: 上传文件 (${fileName}, ${fileSize} bytes)...`);
    const mediaId = await uploadFile(accessToken, filePath);
    console.log(`✅ 文件上传成功 (media_id: ${mediaId.substring(0, 20)}...)`);

    // Step 4: 发送文件消息
    console.log(`Step 4: 发送文件消息给 ${userId}...`);
    const result = await sendFileMessage(accessToken, userId, mediaId);
    console.log(`✅ 文件发送成功! msgid: ${result.msgid || "ok"}`);

    // 输出 JSON 结果
    console.log(
      JSON.stringify({
        success: true,
        userId,
        fileName,
        fileSize,
        mediaId,
        msgid: result.msgid,
      }),
    );
  } catch (error) {
    console.error(`❌ ${error.message}`);
    console.log(JSON.stringify({ success: false, error: error.message }));
    process.exit(1);
  }
}

main();
