import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/msteams";
import { getMSTeamsRuntime } from "../runtime.js";
import { downloadMSTeamsAttachments } from "./download.js";
import { downloadAndStoreMSTeamsRemoteMedia } from "./remote-media.js";
import {
  applyAuthorizationHeaderForUrl,
  GRAPH_ROOT,
  inferPlaceholder,
  isRecord,
  isUrlAllowed,
  normalizeContentType,
  resolveMediaSsrfPolicy,
  resolveAttachmentFetchPolicy,
  resolveRequestUrl,
  safeFetchWithPolicy
} from "./shared.js";
function readNestedString(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return void 0;
    }
    current = current[key];
  }
  return typeof current === "string" && current.trim() ? current.trim() : void 0;
}
function buildMSTeamsGraphMessageUrls(params) {
  const conversationType = params.conversationType?.trim().toLowerCase() ?? "";
  const messageIdCandidates = /* @__PURE__ */ new Set();
  const pushCandidate = (value) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) {
      messageIdCandidates.add(trimmed);
    }
  };
  pushCandidate(params.messageId);
  pushCandidate(params.conversationMessageId);
  pushCandidate(readNestedString(params.channelData, ["messageId"]));
  pushCandidate(readNestedString(params.channelData, ["teamsMessageId"]));
  const replyToId = typeof params.replyToId === "string" ? params.replyToId.trim() : "";
  if (conversationType === "channel") {
    const teamId = readNestedString(params.channelData, ["team", "id"]) ?? readNestedString(params.channelData, ["teamId"]);
    const channelId = readNestedString(params.channelData, ["channel", "id"]) ?? readNestedString(params.channelData, ["channelId"]) ?? readNestedString(params.channelData, ["teamsChannelId"]);
    if (!teamId || !channelId) {
      return [];
    }
    const urls2 = [];
    if (replyToId) {
      for (const candidate of messageIdCandidates) {
        if (candidate === replyToId) {
          continue;
        }
        urls2.push(
          `${GRAPH_ROOT}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(replyToId)}/replies/${encodeURIComponent(candidate)}`
        );
      }
    }
    if (messageIdCandidates.size === 0 && replyToId) {
      messageIdCandidates.add(replyToId);
    }
    for (const candidate of messageIdCandidates) {
      urls2.push(
        `${GRAPH_ROOT}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(candidate)}`
      );
    }
    return Array.from(new Set(urls2));
  }
  const chatId = params.conversationId?.trim() || readNestedString(params.channelData, ["chatId"]);
  if (!chatId) {
    return [];
  }
  if (messageIdCandidates.size === 0 && replyToId) {
    messageIdCandidates.add(replyToId);
  }
  const urls = Array.from(messageIdCandidates).map(
    (candidate) => `${GRAPH_ROOT}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(candidate)}`
  );
  return Array.from(new Set(urls));
}
async function fetchGraphCollection(params) {
  const fetchFn = params.fetchFn ?? fetch;
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    fetchImpl: fetchFn,
    init: {
      headers: { Authorization: `Bearer ${params.accessToken}` }
    },
    policy: params.ssrfPolicy,
    auditContext: "msteams.graph.collection"
  });
  try {
    const status = response.status;
    if (!response.ok) {
      return { status, items: [] };
    }
    try {
      const data = await response.json();
      return { status, items: Array.isArray(data.value) ? data.value : [] };
    } catch {
      return { status, items: [] };
    }
  } finally {
    await release();
  }
}
function normalizeGraphAttachment(att) {
  let content = att.content;
  if (typeof content === "string") {
    try {
      content = JSON.parse(content);
    } catch {
    }
  }
  return {
    contentType: normalizeContentType(att.contentType) ?? void 0,
    contentUrl: att.contentUrl ?? void 0,
    name: att.name ?? void 0,
    thumbnailUrl: att.thumbnailUrl ?? void 0,
    content
  };
}
async function downloadGraphHostedContent(params) {
  const hosted = await fetchGraphCollection({
    url: `${params.messageUrl}/hostedContents`,
    accessToken: params.accessToken,
    fetchFn: params.fetchFn,
    ssrfPolicy: params.ssrfPolicy
  });
  if (hosted.items.length === 0) {
    return { media: [], status: hosted.status, count: 0 };
  }
  const out = [];
  for (const item of hosted.items) {
    const contentBytes = typeof item.contentBytes === "string" ? item.contentBytes : "";
    if (!contentBytes) {
      continue;
    }
    let buffer;
    try {
      buffer = Buffer.from(contentBytes, "base64");
    } catch {
      continue;
    }
    if (buffer.byteLength > params.maxBytes) {
      continue;
    }
    const mime = await getMSTeamsRuntime().media.detectMime({
      buffer,
      headerMime: item.contentType ?? void 0
    });
    try {
      const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(
        buffer,
        mime ?? item.contentType ?? void 0,
        "inbound",
        params.maxBytes
      );
      out.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder: inferPlaceholder({ contentType: saved.contentType })
      });
    } catch {
    }
  }
  return { media: out, status: hosted.status, count: hosted.items.length };
}
async function downloadMSTeamsGraphMedia(params) {
  if (!params.messageUrl || !params.tokenProvider) {
    return { media: [] };
  }
  const policy = resolveAttachmentFetchPolicy({
    allowHosts: params.allowHosts,
    authAllowHosts: params.authAllowHosts
  });
  const ssrfPolicy = resolveMediaSsrfPolicy(policy.allowHosts);
  const messageUrl = params.messageUrl;
  let accessToken;
  try {
    accessToken = await params.tokenProvider.getAccessToken("https://graph.microsoft.com");
  } catch {
    return { media: [], messageUrl, tokenError: true };
  }
  const fetchFn = params.fetchFn ?? fetch;
  const sharePointMedia = [];
  const downloadedReferenceUrls = /* @__PURE__ */ new Set();
  try {
    const { response: msgRes, release } = await fetchWithSsrFGuard({
      url: messageUrl,
      fetchImpl: fetchFn,
      init: {
        headers: { Authorization: `Bearer ${accessToken}` }
      },
      policy: ssrfPolicy,
      auditContext: "msteams.graph.message"
    });
    try {
      if (msgRes.ok) {
        const msgData = await msgRes.json();
        const spAttachments = (msgData.attachments ?? []).filter(
          (a) => a.contentType === "reference" && a.contentUrl && a.name
        );
        for (const att of spAttachments) {
          const name = att.name ?? "file";
          try {
            const shareUrl = att.contentUrl;
            if (!isUrlAllowed(shareUrl, policy.allowHosts)) {
              continue;
            }
            const encodedUrl = Buffer.from(shareUrl).toString("base64url");
            const sharesUrl = `${GRAPH_ROOT}/shares/u!${encodedUrl}/driveItem/content`;
            const media = await downloadAndStoreMSTeamsRemoteMedia({
              url: sharesUrl,
              filePathHint: name,
              maxBytes: params.maxBytes,
              contentTypeHint: "application/octet-stream",
              preserveFilenames: params.preserveFilenames,
              ssrfPolicy,
              fetchImpl: async (input, init) => {
                const requestUrl = resolveRequestUrl(input);
                const headers = new Headers(init?.headers);
                applyAuthorizationHeaderForUrl({
                  headers,
                  url: requestUrl,
                  authAllowHosts: policy.authAllowHosts,
                  bearerToken: accessToken
                });
                return await safeFetchWithPolicy({
                  url: requestUrl,
                  policy,
                  fetchFn,
                  requestInit: {
                    ...init,
                    headers
                  }
                });
              }
            });
            sharePointMedia.push(media);
            downloadedReferenceUrls.add(shareUrl);
          } catch {
          }
        }
      }
    } finally {
      await release();
    }
  } catch {
  }
  const hosted = await downloadGraphHostedContent({
    accessToken,
    messageUrl,
    maxBytes: params.maxBytes,
    fetchFn: params.fetchFn,
    preserveFilenames: params.preserveFilenames,
    ssrfPolicy
  });
  const attachments = await fetchGraphCollection({
    url: `${messageUrl}/attachments`,
    accessToken,
    fetchFn: params.fetchFn,
    ssrfPolicy
  });
  const normalizedAttachments = attachments.items.map(normalizeGraphAttachment);
  const filteredAttachments = sharePointMedia.length > 0 ? normalizedAttachments.filter((att) => {
    const contentType = att.contentType?.toLowerCase();
    if (contentType !== "reference") {
      return true;
    }
    const url = typeof att.contentUrl === "string" ? att.contentUrl : "";
    if (!url) {
      return true;
    }
    return !downloadedReferenceUrls.has(url);
  }) : normalizedAttachments;
  const attachmentMedia = await downloadMSTeamsAttachments({
    attachments: filteredAttachments,
    maxBytes: params.maxBytes,
    tokenProvider: params.tokenProvider,
    allowHosts: policy.allowHosts,
    authAllowHosts: policy.authAllowHosts,
    fetchFn: params.fetchFn,
    preserveFilenames: params.preserveFilenames
  });
  return {
    media: [...sharePointMedia, ...hosted.media, ...attachmentMedia],
    hostedCount: hosted.count,
    attachmentCount: filteredAttachments.length + sharePointMedia.length,
    hostedStatus: hosted.status,
    attachmentStatus: attachments.status,
    messageUrl
  };
}
export {
  buildMSTeamsGraphMessageUrls,
  downloadMSTeamsGraphMedia
};
