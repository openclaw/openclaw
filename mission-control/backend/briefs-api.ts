import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const VAULT_ROOT = join(homedir(), "Documents", "SecondBrain");
const INBOX = join(VAULT_ROOT, "Agents", "CousinGreg", "briefs", "inbox");
const SENT = join(VAULT_ROOT, "Agents", "CousinGreg", "briefs", "sent");

const NAME_RE = /^[^/\\]+\.md$/;

const BodySchema = z.object({ name: z.string() });

function validateName(name: string): { ok: true } | { ok: false; error: string } {
  if (!NAME_RE.test(name) || name.includes("..") || name.includes(sep)) {
    return { ok: false, error: "invalid filename" };
  }
  return { ok: true };
}

export function registerBriefsRoutes(app: FastifyInstance): void {
  app.get("/api/briefs/inbox", async (_req, reply) => {
    let files: string[] = [];
    try {
      files = readdirSync(INBOX).filter((f) => f.endsWith(".md"));
    } catch {
      // inbox does not exist yet
    }
    const briefs = files.map((name) => {
      const full = join(INBOX, name);
      let content = "";
      let mtimeMs = 0;
      try {
        content = readFileSync(full, "utf8");
        mtimeMs = statSync(full).mtimeMs;
      } catch { /* skip unreadable */ }
      return { name, content, mtimeMs };
    });
    return reply.send({ briefs });
  });

  app.post("/api/briefs/approve", async (req, reply) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" });
    const valid = validateName(parsed.data.name);
    if (!valid.ok) return reply.code(400).send({ error: valid.error });
    const src = join(INBOX, parsed.data.name);
    const dst = join(SENT, parsed.data.name);
    try {
      statSync(src);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    mkdirSync(SENT, { recursive: true });
    renameSync(src, dst);
    return reply.send({ ok: true });
  });

  app.post("/api/briefs/reject", async (req, reply) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" });
    const valid = validateName(parsed.data.name);
    if (!valid.ok) return reply.code(400).send({ error: valid.error });
    const src = join(INBOX, parsed.data.name);
    try {
      statSync(src);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    rmSync(src);
    return reply.send({ ok: true });
  });
}
