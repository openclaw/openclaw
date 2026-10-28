import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}
loadEnv();

const HOST = "127.0.0.1";
const PORT = Number(process.env.SHOPMINI_PORT || 4173);
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789/v1/chat/completions";
const MODEL = process.env.OPENCLAW_MODEL || "openclaw/default";
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

function send(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
}
async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) throw new Error("Tin nhắn quá lớn.");
  }
  return JSON.parse(raw || "{}");
}
function parseJsonReply(content) {
  const cleaned = String(content || "").trim().replace(/^\uFEFF/, "").replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
  return JSON.parse(cleaned);
}
async function askOpenClaw(mode, message, catalog) {
  if (!TOKEN) throw new Error("Chưa cấu hình OPENCLAW_GATEWAY_TOKEN trong file .env.");
  const isManage = mode === "manage";
  const system = isManage
    ? `Bạn là trợ lý vận hành ShopMini. Chỉ trích xuất thông tin do người dùng cung cấp; không tự bịa giá, số lượng, tên sản phẩm hay khách hàng. Trả về DUY NHẤT JSON hợp lệ, không Markdown, theo dạng {"reply":"câu trả lời tiếng Việt","action":null} hoặc action là một trong hai dạng:
{"type":"record_sale","productId":"ID có trong danh mục","quantity":2,"customer":"Tên khách hoặc Khách lẻ"}
{"type":"add_product","name":"Tên sản phẩm","price":100000,"stock":5,"cost":null}
Chỉ record_sale khi người dùng xác nhận đã bán/đã chốt bán, sản phẩm khớp chính xác với danh mục và số lượng là số nguyên dương. Nếu chưa có đủ thông tin hoặc sản phẩm mơ hồ, action phải là null và hãy hỏi lại. Không tạo đơn khi khách chỉ hỏi giá. Với add_product, bắt buộc người dùng nêu rõ tên, giá bán và số lượng ban đầu; thiếu dữ liệu thì hỏi lại. cost chỉ dùng nếu người dùng nêu rõ giá vốn, nếu không để null. Không bao giờ tự thêm sản phẩm trùng tên đang có. Không xử lý yêu cầu xóa sản phẩm, thay đổi giá, hoàn tiền hoặc thao tác khác. Catalog hiện tại: ${JSON.stringify(catalog)}`
    : `Bạn là nhân viên tư vấn khách hàng thân thiện của cửa hàng ShopMini. Trả lời bằng tiếng Việt, ngắn gọn, dựa CHỈ trên danh mục sản phẩm được cung cấp. Không tiết lộ dữ liệu nội bộ, khách hàng, đơn hàng, giá vốn hay tồn kho chính xác. Nếu không biết, nói sẽ nhờ nhân viên kiểm tra. Không tự nhận đã đặt hàng hoặc thanh toán. Danh mục công khai: ${JSON.stringify((catalog.products || []).map(p => ({ name: p.name, price: p.price, available: p.stock > 0 })))}`;
  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN },
    body: JSON.stringify({ model: MODEL, stream: false, temperature: 0.2, max_tokens: 700, messages: [{ role: "system", content: system }, { role: "user", content: message }] }),
    signal: AbortSignal.timeout(65_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `OpenClaw trả về lỗi HTTP ${response.status}.`);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("OpenClaw không trả về nội dung.");
  if (!isManage) return { reply: content.trim(), action: null };
  try {
    const parsed = parseJsonReply(content);
    return { reply: String(parsed.reply || "Đã xử lý yêu cầu."), action: parsed.action && typeof parsed.action === "object" ? parsed.action : null };
  } catch {
    return { reply: "Tôi chưa đọc được yêu cầu thành dữ liệu an toàn. Bạn hãy ghi rõ tên sản phẩm, số lượng và xác nhận đã bán; hoặc tên, giá bán, số lượng khi thêm sản phẩm.", action: null };
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (req.method === "POST" && url.pathname === "/api/assistant") {
      const body = await readBody(req);
      const mode = body.mode === "customer" ? "customer" : "manage";
      const message = String(body.message || "").trim();
      if (!message || message.length > 1200) return send(res, 400, { error: "Tin nhắn phải có từ 1 đến 1200 ký tự." });
      const catalog = body.catalog && typeof body.catalog === "object" ? body.catalog : { products: [] };
      const result = await askOpenClaw(mode, message, catalog);
      return send(res, 200, result);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });
    const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.resolve(ROOT, "." + pathname);
    if (!file.startsWith(ROOT + path.sep) || !TYPES[path.extname(file)]) return send(res, 403, { error: "Forbidden" });
    let body;
    try { body = readFileSync(file); } catch { return send(res, 404, { error: "Not found" }); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)], "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
    if (req.method === "HEAD") return res.end();
    return res.end(body);
  } catch (error) {
    return send(res, 500, { error: error instanceof Error ? error.message : "Lỗi máy chủ." });
  }
});
server.listen(PORT, HOST, () => {
  console.log(`ShopMini đang chạy tại http://${HOST}:${PORT}`);
  console.log(`OpenClaw Gateway: ${GATEWAY_URL} | model: ${MODEL}`);
  if (!TOKEN) console.log("Chưa cấu hình token: sao chép .env.example thành .env và thêm gateway token.");
});
