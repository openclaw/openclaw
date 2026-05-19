// Bundled "portable-context" command plugin.
//
// Adds a `/export_context` native command. When invoked from a DM it bundles a short
// header + the agent workspace USER.md + MEMORY.md into a single .md file and
// delivers it as a Telegram document (via the outbound mediaUrl path).
//
// Scope (P6-3b / stage B): adds a 4th block — a recent-conversation
// compression section generated via a Gemma4 self-call. On ANY failure the
// 3-block CONTEXT.md still ships normally (the section is silently omitted).
//
// Multi-agent (2026-05-18, "luna support"): supports both gemma (single-tenant
// workspace) and luna (multi-tenant — caller-specific subdir under
// workspace/users/) by branching on ctx.accountId. The on-disk layout is the
// only thing that differs; the resulting CONTEXT.md format is identical.

import { readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";

type AgentId = "gemma" | "luna";

// PluginCommandContext exposes no chat-type field. Telegram group/channel ids
// are negative; private chats use a positive user id. Treat a negative target
// (or a forum/topic thread id) as "not a DM".
function looksLikeGroupTarget(value: string | undefined): boolean {
  const v = (value ?? "").trim();
  return v.length > 0 && v.startsWith("-");
}

// Map ctx.accountId (openclaw.json channels.telegram.accounts key) to an
// agentId. Default to gemma for backward compat — only "luna" branches off.
function resolveAgentId(accountId: string | undefined): AgentId {
  return accountId === "luna" ? "luna" : "gemma";
}

// Resolve on-disk paths to USER.md + MEMORY.md for the caller.
//
// - gemma: single-tenant. Always reads workspace root.
// - luna:  multi-tenant. luna's dump_users_to_md.py lays out per-user dirs as
//          workspace/users/{prefix?}{chat_id}-{slug}/. prefix is "00-" for the
//          admin row, empty otherwise. Match by exact-or-bounded chat_id.
async function resolveContextPaths(
  agentId: AgentId,
  senderId: string,
): Promise<{ userMdPath: string; memoryMdPath: string } | null> {
  if (agentId === "gemma") {
    const wsDir = path.join(os.homedir(), ".openclaw/agents/gemma/workspace");
    return {
      userMdPath: path.join(wsDir, "USER.md"),
      memoryMdPath: path.join(wsDir, "MEMORY.md"),
    };
  }
  // luna: glob workspace/users/ for an entry whose chat_id segment matches.
  const usersRoot = path.join(os.homedir(), ".openclaw/agents/luna/workspace/users");
  let entries: string[];
  try {
    entries = await readdir(usersRoot);
  } catch {
    return null;
  }
  // Skip archive-prefixed dirs (e.g. "_archive-..."). Real per-user dirs are
  // either "<chat_id>-<slug>" or "<prefix>-<chat_id>-<slug>" where <prefix>
  // is a short numeric sort prefix like "00" (admin).
  // senderId is sanitized to digits only before going into the regex.
  const safeSender = senderId.replace(/[^0-9]/g, "");
  if (!safeSender) return null;
  const re = new RegExp(`(?:^|-)${safeSender}-`);
  const matches = entries.filter((e) => !e.startsWith("_") && re.test(e));
  if (matches.length === 0) return null;
  // Prefer admin-prefixed match if present (the operator), but normally there
  // will be exactly one match.
  const chosen = matches.find((m) => m.startsWith("00-")) ?? matches[0];
  const userDir = path.join(usersRoot, chosen);
  return {
    userMdPath: path.join(userDir, "USER.md"),
    memoryMdPath: path.join(userDir, "MEMORY.md"),
  };
}

// P6-3b: exact system prompt mandated by the spec (do not paraphrase).
const COMPRESS_SYSTEM_PROMPT =
  "다음은 사용자와 AI 비서의 최근 대화 기록이다. 이 대화의 내용을 약 8000자 정도로 압축하라.\n" +
  "\n" +
  "중요 원칙:\n" +
  '- 이것은 "요약"이 아니라 "압축"이다. 정보 보존이 매끄러운 문장보다 우선이다.\n' +
  "- 구체적인 사실, 숫자, 이름, 시간, 결정사항, 진행 중인 일, 약속, 상태 변화는 모두 보존하라.\n" +
  '- 인삿말이나 군더더기, 단순 확인 응답("응", "OK")만 제거하라.\n' +
  "- 한국어로 작성하라.\n" +
  "- 시간 순서를 유지하라.\n" +
  "- 출력은 압축본 본문만. 헤더나 메타 설명 금지.";

// Read the most recent conversation messages for this sender from the agent's
// session jsonl (read-only). Accumulates from newest backwards up to a 50KB
// raw byte cap, then returns chronological order. Any I/O or parse failure
// degrades to [] (caller omits the compression section).
async function readRecentMessages(
  agentId: AgentId,
  senderId: string,
): Promise<Array<{ role: string; text: string }>> {
  const sessionKey = `agent:${agentId}:telegram:direct:${senderId}`;
  const sessionsPath = path.join(
    os.homedir(),
    `.openclaw/agents/${agentId}/sessions/sessions.json`,
  );
  let sessions: Record<string, { sessionId?: string } | undefined>;
  try {
    sessions = JSON.parse(await readFile(sessionsPath, "utf-8")) as Record<
      string,
      { sessionId?: string } | undefined
    >;
  } catch {
    return [];
  }
  const sessionId = sessions[sessionKey]?.sessionId;
  if (!sessionId) return [];

  const jsonlPath = path.join(
    os.homedir(),
    `.openclaw/agents/${agentId}/sessions/${sessionId}.jsonl`,
  );
  let jsonlRaw: string;
  try {
    jsonlRaw = await readFile(jsonlPath, "utf-8");
  } catch {
    return [];
  }

  const lines = jsonlRaw.split("\n");
  const collected: Array<{ role: string; text: string }> = [];
  let accumBytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let rec: {
      type?: string;
      message?: { role?: string; content?: unknown };
    };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    if (rec.type !== "message" || !rec.message) continue;
    const role = (rec.message.role ?? "").trim();
    if (!role) continue;

    const rawContent = rec.message.content;
    let text: string;
    if (typeof rawContent === "string") {
      text = rawContent;
    } else if (Array.isArray(rawContent)) {
      text = rawContent
        .filter((p): p is { type?: string; text?: string } => !!p && typeof p === "object")
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("");
    } else {
      text = "";
    }
    if (!text) continue;

    const byteLen = Buffer.byteLength(text, "utf8");
    if (accumBytes + byteLen > 50000) break;
    accumBytes += byteLen;
    collected.push({ role, text });
  }
  collected.reverse();
  return collected;
}

// Compress the given message sequence via the local Gemma4 vLLM endpoint.
// Returns the compressed text (utf-8-safe trimmed to 16384 bytes) or null on
// empty input / fetch error / timeout / empty response.
async function compressRecentConversation(
  messages: Array<{ role: string; text: string }>,
): Promise<string | null> {
  if (messages.length === 0) return null;
  try {
    const serialized = messages.map((m) => `[${m.role}] ${m.text}`).join("\n\n");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let data: { choices?: Array<{ message?: { content?: string } }> };
    try {
      const res = await fetch("http://localhost:8005/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemma4-26b-nvfp4",
          messages: [
            { role: "system", content: COMPRESS_SYSTEM_PROMPT },
            { role: "user", content: serialized },
          ],
          max_tokens: 8192,
          temperature: 0.3,
        }),
        signal: controller.signal,
      });
      data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
    } finally {
      clearTimeout(timer);
    }

    const out = data?.choices?.[0]?.message?.content;
    if (!out || typeof out !== "string") return null;

    const buf = Buffer.from(out, "utf8");
    if (buf.length <= 16384) return out;
    // Trim to 16384 bytes, dropping a trailing broken multibyte sequence.
    let end = 16384;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
    return buf.subarray(0, end).toString("utf8");
  } catch {
    return null;
  }
}

export default function register(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "export_context",
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

        // 3. Decide which agent's workspace + sessions to read.
        const agentId = resolveAgentId(ctx.accountId);

        // 4. Resolve on-disk USER/MEMORY paths for this agent + sender.
        const paths = await resolveContextPaths(agentId, senderId);
        if (!paths) {
          return {
            text:
              agentId === "luna"
                ? `네 정보를 워크스페이스에서 찾지 못했어 (chat_id ${senderId}). 루나에 한 번이라도 말 걸어본 적이 있어야 dump 가 생성돼.`
                : "워크스페이스가 초기화되지 않아 내보내기를 중단했어.",
            isError: true,
          };
        }

        // 5. Read the workspace context (read-only).
        let userMd: string;
        let memoryMd: string;
        try {
          userMd = await readFile(paths.userMdPath, "utf-8");
        } catch {
          return {
            text: `USER.md 를 찾을 수 없어 내보내기를 중단했어. (${agentId} workspace 미초기화)`,
            isError: true,
          };
        }
        try {
          memoryMd = await readFile(paths.memoryMdPath, "utf-8");
        } catch {
          return {
            text: `MEMORY.md 를 찾을 수 없어 내보내기를 중단했어. (${agentId} workspace 미초기화)`,
            isError: true,
          };
        }

        // 6. Assemble: header + USER.md + MEMORY.md.
        const header =
          "# CONTEXT.md - About This Person\n" +
          `- 이 파일을 업로드한 사람의 식별자: ${senderId}\n` +
          "- 아래 내용은 모두 이 사람에 대한 정보임.\n\n";
        const content = `${header}${userMd.trim()}\n\n${memoryMd.trim()}\n`;

        // 7. Append recent conversation compression (Gemma4 self-call).
        //    On any failure (no messages / fetch error / timeout / empty),
        //    silently omit the section. The 3-block CONTEXT.md still ships.
        let finalContent = content;
        try {
          const messages = await readRecentMessages(agentId, senderId);
          if (messages.length > 0) {
            const compressed = await compressRecentConversation(messages);
            if (compressed && compressed.trim()) {
              finalContent =
                content +
                "\n# 최근 대화 압축본 (Gemma4 생성, 최대 16KB)\n\n" +
                compressed.trim() +
                "\n";
            }
          }
        } catch {
          // silent fallback to 3-block content
        }

        // 8. Write into OpenClaw's preferred tmp dir so the Telegram outbound
        //    pipeline's mediaLocalRoots allowlist accepts the file:// url.
        //    The basename becomes the delivered document filename.
        const safeId = senderId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "user";
        const tmpPath = path.join(
          resolvePreferredOpenClawTmpDir(),
          `CONTEXT-${safeId}-${Date.now()}.md`,
        );
        await writeFile(tmpPath, finalContent, "utf-8");

        // 9. Returning mediaUrl lets the outbound pipeline deliver it as a
        //    document (`.md` is not image/video/audio → api.sendDocument).
        //    The temp file is intentionally left for OpenClaw's tmp reaper:
        //    the send happens asynchronously after this handler returns, so
        //    unlinking here would race the upload.
        const guidance =
          agentId === "luna"
            ? "내보냈어. 이 봇이 있는 그룹에 첨부 업로드하면 자동 인식돼. ⚠ 첨부 시 USER.md 본문이 그 그룹 jsonl 에 영구 기록되니 사적 내용 확인 후 올려."
            : "내보냈어. 사용 안내: 젬마 있는 그룹에 이 .md 를 첨부 업로드하면 자동 인식돼.";
        return {
          text: guidance,
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
