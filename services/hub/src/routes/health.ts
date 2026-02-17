import { Hono } from "hono";

const health = new Hono();

health.get("/health", (c) => c.json({ status: "ok" }));

export { health };
