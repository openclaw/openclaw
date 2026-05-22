/**
 * REST API HTTP 服务器工厂
 *
 * 使用 Node.js `node:http` 创建服务器，包装 createClaworksRestHandler。
 * port=0 时系统自动分配随机端口（适合集成测试，避免端口冲突）。
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { ClaworksRuntime } from "../../claworks/runtime-types.js";
import { createClaworksRestHandler } from "./router.js";

export async function createRestServer(
  runtime: ClaworksRuntime,
  port: number,
): Promise<{ server: Server; port: number }> {
  const handler = createClaworksRestHandler(runtime);

  const server = createServer(async (req, res) => {
    try {
      const handled = await handler(req, res);
      if (!handled) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Not Found" }));
      }
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;

  return { server, port: actualPort };
}
