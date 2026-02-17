import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { timingSafeEqual } from "node:crypto";
import type { Env } from "../env.js";
import { createSession, validateSession, destroySession } from "../auth/sessions.js";

export function createAuthRoutes(env: Env) {
  const auth = new Hono();

  auth.post("/api/auth/login", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const password = body.password;
    if (typeof password !== "string") {
      return c.json({ error: "Missing password" }, 400);
    }

    // Timing-safe comparison
    const expected = Buffer.from(env.ADMIN_PASSWORD);
    const provided = Buffer.from(password);
    const valid = expected.length === provided.length && timingSafeEqual(expected, provided);

    if (!valid) {
      return c.json({ error: "Invalid password" }, 401);
    }

    const token = createSession();
    setCookie(c, "hub_session", token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 24 * 60 * 60,
    });

    return c.json({ ok: true });
  });

  auth.post("/api/auth/logout", (c) => {
    const token = getCookie(c, "hub_session");
    if (token) {
      destroySession(token);
    }
    deleteCookie(c, "hub_session", { path: "/" });
    return c.json({ ok: true });
  });

  auth.get("/api/auth/me", (c) => {
    const token = getCookie(c, "hub_session");
    const authenticated = !!token && validateSession(token);
    return c.json({ authenticated });
  });

  return auth;
}
