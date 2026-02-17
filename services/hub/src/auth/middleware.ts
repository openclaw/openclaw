import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { validateSession } from "./sessions.js";

export const requireAuth = createMiddleware(async (c, next) => {
  const token = getCookie(c, "hub_session");
  if (!token || !validateSession(token)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});
