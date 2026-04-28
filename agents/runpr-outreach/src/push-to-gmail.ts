// Push a drafted email into Gmail's drafts folder via the `gog` CLI (already authenticated as
// jeff@hypelab.digital on forge). We pass the body via temp file rather than --body flag to
// preserve newlines, and use --body-html for the rich version.

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Contact, DraftEmail } from "./types.js";

interface GmailDraftResult {
  draft_id?: string;
  draft_url?: string;
  raw: string;
}

function runGog(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("gog", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code: code ?? -1,
      });
    });
  });
}

function parseDraftIdFromOutput(stdout: string): string | undefined {
  // gog typically prints something like: "Draft created: r1234..." or JSON. Try both.
  try {
    const j = JSON.parse(stdout);
    if (j && typeof j === "object") {
      if (j.id) return String(j.id);
      if (j.draftId) return String(j.draftId);
      if (j.draft && j.draft.id) return String(j.draft.id);
    }
  } catch {
    /* fall through */
  }
  const m = stdout.match(/r[-\w]{10,}/);
  return m?.[0];
}

export async function pushDraftToGmail(opts: {
  account: string;
  to: string;
  contact: Contact;
  draft: DraftEmail;
}): Promise<GmailDraftResult> {
  const { account, to, draft } = opts;
  const dir = await mkdtemp(join(tmpdir(), "runpr-draft-"));
  const txtPath = join(dir, "body.txt");
  const htmlPath = join(dir, "body.html");
  await writeFile(txtPath, draft.body_text, "utf8");
  await writeFile(htmlPath, draft.body_html, "utf8");

  try {
    const args = [
      "gmail",
      "drafts",
      "create",
      "--account",
      account,
      "--to",
      to,
      "--subject",
      draft.subject,
      "--body-file",
      txtPath,
      "--body-html-file",
      htmlPath,
    ];
    const { stdout, stderr, code } = await runGog(args);
    if (code !== 0) {
      // Some gog versions don't accept --body-html-file. Retry with --body-html (inline).
      if (/unknown flag.*body-html-file/i.test(stderr)) {
        const fallbackArgs = [
          "gmail",
          "drafts",
          "create",
          "--account",
          account,
          "--to",
          to,
          "--subject",
          draft.subject,
          "--body-file",
          txtPath,
          "--body-html",
          draft.body_html,
        ];
        const retry = await runGog(fallbackArgs);
        if (retry.code !== 0) {
          throw new Error(`gog drafts create failed: ${retry.stderr.slice(0, 500)}`);
        }
        const id = parseDraftIdFromOutput(retry.stdout);
        return {
          draft_id: id,
          draft_url: id ? `https://mail.google.com/mail/u/0/#drafts/${id}` : undefined,
          raw: retry.stdout,
        };
      }
      throw new Error(`gog drafts create failed: ${stderr.slice(0, 500)}`);
    }
    const id = parseDraftIdFromOutput(stdout);
    return {
      draft_id: id,
      draft_url: id ? `https://mail.google.com/mail/u/0/#drafts/${id}` : undefined,
      raw: stdout,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
