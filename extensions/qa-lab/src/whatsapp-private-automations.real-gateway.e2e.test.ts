import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";

it.each(["mixed", "static", "connected", "plugin"])(
  "runs a personal WhatsApp task with current %s tools and skips revoked jobs",
  async (source) => {
    const home = await mkdtemp(path.join(tmpdir(), "whatsapp-private-automations-"));
    const script = fileURLToPath(new URL("./whatsapp-private-automations.qa.mts", import.meta.url));
    const cwd = path.resolve(path.dirname(script), "../../..");
    try {
      await promisify(execFile)(
        "node",
        ["--import", "./scripts/tsx.mjs", script, ...(source === "plugin" ? [] : [source])],
        {
          cwd,
          env: { HOME: home, PATH: process.env.PATH, LANG: "C.UTF-8" },
          timeout: 360_000,
        },
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  370_000,
);
