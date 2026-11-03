import { createServer, type ServerResponse } from "node:http";

/** Minimal Urbit Eyre stand-in: login, empty scry, channel PUT acks, and one SSE stream. */
export async function startFakeUrbitSseServer() {
  const ackedEventIds: number[] = [];
  const subscriptionsByApp = new Map<string, number>();
  const streamOpened = Promise.withResolvers<ServerResponse>();
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

    if (req.method === "POST" && pathname === "/~/login") {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Set-Cookie": "urbauth-~zod=proof; Path=/",
      });
      res.end("ok");
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/~/scry/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method === "PUT" && pathname.startsWith("/~/channel/")) {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (part: string) => {
        body += part;
      });
      req.on("end", () => {
        const actions = JSON.parse(body) as Array<{
          id?: number;
          action?: string;
          app?: string;
          "event-id"?: number;
        }>;
        for (const item of actions) {
          if (item.action === "subscribe" && item.app && typeof item.id === "number") {
            subscriptionsByApp.set(item.app, item.id);
          }
          if (item.action === "ack" && typeof item["event-id"] === "number") {
            ackedEventIds.push(item["event-id"]);
          }
        }
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/~/channel/")) {
      res.writeHead(200, {
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream",
      });
      res.write(": connected\n\n");
      streamOpened.resolve(res);
      return;
    }
    if (req.method === "DELETE" && pathname.startsWith("/~/channel/")) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, ackedEventIds, subscriptionsByApp, streamOpened };
}
