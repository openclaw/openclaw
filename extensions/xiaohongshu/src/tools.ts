import type { OpenClawPluginApi } from "openclaw/plugin-sdk/xiaohongshu";
import { XhsClient } from "./client.js";
import {
  CheckCookieSchema,
  SearchNotesSchema,
  GetNoteSchema,
  GetCommentsSchema,
  PostCommentSchema,
  HomeFeedSchema,
  type SearchNotesParams,
  type GetNoteParams,
  type GetCommentsParams,
  type PostCommentParams,
} from "./schemas.js";
import type {
  XhsPluginConfig,
  XhsUserInfo,
  XhsSearchItem,
  XhsFeedItem,
  XhsComment,
} from "./types.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

/** Extract note_id and xsec_token from a Xiaohongshu URL. */
function parseNoteUrl(url: string): { noteId: string; xsecToken: string | undefined } {
  try {
    const parsed = new URL(url);
    const noteId = parsed.pathname.split("/").pop() ?? "";
    const xsecToken = parsed.searchParams.get("xsec_token") ?? undefined;
    return { noteId, xsecToken };
  } catch {
    const parts = url.split("/");
    return { noteId: parts[parts.length - 1] ?? url, xsecToken: undefined };
  }
}

// Long x-s-common header value required for feed/note-content requests.
// Extracted from jobsonlook/xhs-mcp xhs_api.py — this is a static token.
const XS_COMMON =
  "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";

export function registerXhsTools(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as XhsPluginConfig;
  const cookie = cfg.cookie?.trim();
  if (!cookie) {
    api.logger.debug?.("xiaohongshu: No cookie configured, skipping tools");
    return;
  }

  const client = new XhsClient(cookie);

  api.registerTool(
    {
      name: "xhs_check_cookie",
      label: "XHS Check Cookie",
      description: "Verify Xiaohongshu cookie validity and return current user info.",
      parameters: CheckCookieSchema,
      async execute() {
        try {
          const res = await client.request<{ nickname: string }>("/api/sns/web/v2/user/me");
          if (res.success) {
            return json({ valid: true, user: res.data });
          }
          return json({ valid: false, error: res.msg });
        } catch (err) {
          return json({ valid: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "xhs_check_cookie" },
  );

  api.registerTool(
    {
      name: "xhs_search_notes",
      label: "XHS Search Notes",
      description: "Search Xiaohongshu notes by keyword. Returns titles, like counts, and URLs.",
      parameters: SearchNotesSchema,
      async execute(_toolCallId, params) {
        const p = params as SearchNotesParams;
        try {
          const data = {
            keyword: p.keywords,
            page: 1,
            page_size: p.limit ?? 20,
            search_id: client.searchId(),
            sort: "general",
            note_type: 0,
            ext_flags: [],
            geo: "",
            image_formats: JSON.stringify(["jpg", "webp", "avif"]),
          };
          const res = await client.request<{ items: XhsSearchItem[] }>(
            "/api/sns/web/v1/search/notes",
            { method: "POST", data },
          );
          if (!res.data?.items?.length) {
            return json({ results: [], message: `No notes found for "${p.keywords}"` });
          }
          const results = res.data.items
            .filter((item) => item.note_card?.display_title)
            .map((item) => ({
              title: item.note_card.display_title,
              liked_count: item.note_card.interact_info?.liked_count,
              url: `https://www.xiaohongshu.com/explore/${item.id}?xsec_token=${item.xsec_token}`,
            }));
          return json({ results });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "xhs_search_notes" },
  );

  api.registerTool(
    {
      name: "xhs_get_note",
      label: "XHS Get Note",
      description:
        "Get full content of a Xiaohongshu note. URL must include xsec_token query parameter.",
      parameters: GetNoteSchema,
      async execute(_toolCallId, params) {
        const p = params as GetNoteParams;
        try {
          const { noteId, xsecToken } = parseNoteUrl(p.url);
          if (!xsecToken) {
            return json({ error: "URL must include xsec_token parameter" });
          }
          const data = {
            source_note_id: noteId,
            image_formats: ["jpg", "webp", "avif"],
            extra: { need_body_topic: "1" },
            xsec_source: "pc_feed",
            xsec_token: xsecToken,
          };
          const res = await client.request<{ items: XhsFeedItem[] }>("/api/sns/web/v1/feed", {
            method: "POST",
            data,
            signed: true,
            extraHeaders: { "x-s-common": XS_COMMON },
          });
          const item = res.data?.items?.[0];
          if (!item?.note_card) {
            return json({ error: "Note not found or access denied" });
          }
          const card = item.note_card;
          const ts = card.time ? new Date(card.time).toISOString() : undefined;
          return json({
            title: card.title,
            author: card.user?.nickname,
            published_at: ts,
            liked_count: card.interact_info?.liked_count,
            comment_count: card.interact_info?.comment_count,
            collected_count: card.interact_info?.collected_count,
            content: card.desc,
            cover: card.image_list?.[0]?.url_pre,
            url: p.url,
          });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "xhs_get_note" },
  );

  api.registerTool(
    {
      name: "xhs_get_comments",
      label: "XHS Get Comments",
      description: "Get comments on a Xiaohongshu note. URL must include xsec_token.",
      parameters: GetCommentsSchema,
      async execute(_toolCallId, params) {
        const p = params as GetCommentsParams;
        try {
          const { noteId, xsecToken } = parseNoteUrl(p.url);
          if (!xsecToken) {
            return json({ error: "URL must include xsec_token parameter" });
          }
          const res = await client.request<{ comments: XhsComment[] }>(
            "/api/sns/web/v2/comment/page",
            {
              method: "GET",
              params: {
                note_id: noteId,
                cursor: "",
                top_comment_id: "",
                image_formats: "jpg,webp,avif",
                xsec_token: xsecToken,
              },
            },
          );
          if (!res.data?.comments?.length) {
            return json({ comments: [], message: "No comments found" });
          }
          const comments = res.data.comments.map((c) => ({
            nickname: c.user_info?.nickname,
            content: c.content,
            created_at: new Date(c.create_time).toISOString(),
            like_count: c.like_count,
          }));
          return json({ comments });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "xhs_get_comments" },
  );

  api.registerTool(
    {
      name: "xhs_post_comment",
      label: "XHS Post Comment",
      description: "Post a comment on a Xiaohongshu note.",
      parameters: PostCommentSchema,
      async execute(_toolCallId, params) {
        const p = params as PostCommentParams;
        try {
          const data = {
            note_id: p.note_id,
            content: p.comment,
            at_users: [],
          };
          const res = await client.request("/api/sns/web/v1/comment/post", {
            method: "POST",
            data,
            signed: true,
          });
          if (res.success) {
            return json({ success: true });
          }
          return json({ success: false, error: res.msg });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "xhs_post_comment" },
  );

  api.registerTool(
    {
      name: "xhs_home_feed",
      label: "XHS Home Feed",
      description: "Get Xiaohongshu home feed recommendations.",
      parameters: HomeFeedSchema,
      async execute() {
        try {
          const data = {
            category: "homefeed_recommend",
            cursor_score: "",
            image_formats: JSON.stringify(["jpg", "webp", "avif"]),
            need_filter_image: false,
            need_num: 8,
            num: 18,
            note_index: 33,
            refresh_type: 1,
            search_key: "",
            unread_begin_note_id: "",
            unread_end_note_id: "",
            unread_note_count: 0,
          };
          const res = await client.request<{ items: XhsFeedItem[] }>("/api/sns/web/v1/homefeed", {
            method: "POST",
            data,
            signed: true,
          });
          if (!res.data?.items?.length) {
            return json({ results: [], message: "No feed items" });
          }
          const results = res.data.items
            .filter((item) => item.note_card?.display_title)
            .map((item) => ({
              title: item.note_card.display_title,
              liked_count: item.note_card.interact_info?.liked_count,
              url: `https://www.xiaohongshu.com/explore/${item.id}?xsec_token=${item.xsec_token}`,
            }));
          return json({ results });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "xhs_home_feed" },
  );

  api.logger.info?.("xiaohongshu: Registered 6 tools");
}
