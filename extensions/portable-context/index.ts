// Bundled "portable-context" command plugin.
//
// Adds a `/export` native command. When invoked from a DM it bundles a short
// header + the gemma workspace USER.md + MEMORY.md into a single .md file and
// delivers it as a Telegram document (via the outbound mediaUrl path).
//
// Scope (P6-3a / stage A): NO compressed-context section — that arrives in
// P6-3b. Keep this handler minimal and self-contained.

import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";

// PluginCommandContext exposes no chat-type field. Telegram group/channel ids
// are negative; private chats use a positive user id. Treat a negative target
// (or a forum/topic thread id) as "not a DM".
function looksLikeGroupTarget(value: string | undefined): boolean {
  const v = (value ?? "").trim();
  return v.length > 0 && v.startsWith("-");
}

export default function register(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "export",
    description: "Export your USER.md + MEMORY.md as a single portable .md document (DM only).",
    acceptsArgs: false,
    handler: async (ctx) => {
      try {
        // 1. DM-only gate (heuristic — see looksLikeGroupTarget).
        const target = ctx.to ?? ctx.from ?? ctx.senderId;
        if (looksLikeGroupTarget(target) || ctx.messageThreadId != null) {
          return { text: "DM 에서만 사용 가능합니다.", isError: true };
        }

        // 2. Sender identity. Only senderId is available on the command
        //    context (no display name); use it for the header + filename.
        const senderId = (ctx.senderId ?? "").trim() || "unknown";

        // 3. Read the gemma workspace context (read-only).
        const wsDir = path.join(os.homedir(), ".openclaw/agents/gemma/workspace");
        let userMd: string;
        let memoryMd: string;
        try {
          userMd = await readFile(path.join(wsDir, "USER.md"), "utf-8");
        } catch {
          return {
            text: "USER.md 를 찾을 수 없어 내보내기를 중단했어. (gemma workspace 미초기화)",
            isError: true,
          };
        }
        try {
          memoryMd = await readFile(path.join(wsDir, "MEMORY.md"), "utf-8");
        } catch {
          return {
            text: "MEMORY.md 를 찾을 수 없어 내보내기를 중단했어. (gemma workspace 미초기화)",
            isError: true,
          };
        }

        // 4. Assemble: header + USER.md + MEMORY.md.
        //    (Compressed-context section is intentionally omitted — P6-3b.)
        const header =
          "# CONTEXT.md - About This Person\n" +
          `- 이 파일을 업로드한 사람의 식별자: ${senderId}\n` +
          "- 아래 내용은 모두 이 사람에 대한 정보임.\n\n";
        const content = `${header}${userMd.trim()}\n\n${memoryMd.trim()}\n`;

        // 5. Write into OpenClaw's preferred tmp dir so the Telegram outbound
        //    pipeline's mediaLocalRoots allowlist accepts the file:// url.
        //    The basename becomes the delivered document filename.
        const safeId = senderId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "user";
        const tmpPath = path.join(
          resolvePreferredOpenClawTmpDir(),
          `CONTEXT-${safeId}-${Date.now()}.md`,
        );
        await writeFile(tmpPath, content, "utf-8");

        // 6. Returning mediaUrl lets the outbound pipeline deliver it as a
        //    document (`.md` is not image/video/audio → api.sendDocument).
        //    The temp file is intentionally left for OpenClaw's tmp reaper:
        //    the send happens asynchronously after this handler returns, so
        //    unlinking here would race the upload.
        return {
          text: "내보냈어. 사용 안내: 젬마 있는 그룹에 이 .md 를 첨부 업로드하면 자동 인식돼.",
          mediaUrl: `file://${tmpPath}`,
        };
      } catch (err) {
        return {
          text: `내보내기 중 오류가 발생했어: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  });
}
