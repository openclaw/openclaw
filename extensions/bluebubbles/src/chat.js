import crypto from "node:crypto";
import path from "node:path";
import { resolveBlueBubblesServerAccount } from "./account-resolve.js";
import { assertMultipartActionOk, postMultipartFormData } from "./multipart.js";
import { getCachedBlueBubblesPrivateApiStatus } from "./probe.js";
import { blueBubblesFetchWithTimeout, buildBlueBubblesApiUrl } from "./types.js";
function resolveAccount(params) {
  return resolveBlueBubblesServerAccount(params);
}
function assertPrivateApiEnabled(accountId, feature) {
  if (getCachedBlueBubblesPrivateApiStatus(accountId) === false) {
    throw new Error(
      `BlueBubbles ${feature} requires Private API, but it is disabled on the BlueBubbles server.`
    );
  }
}
function resolvePartIndex(partIndex) {
  return typeof partIndex === "number" ? partIndex : 0;
}
async function sendBlueBubblesChatEndpointRequest(params) {
  const trimmed = params.chatGuid.trim();
  if (!trimmed) {
    return;
  }
  const { baseUrl, password, accountId } = resolveAccount(params.opts);
  if (getCachedBlueBubblesPrivateApiStatus(accountId) === false) {
    return;
  }
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: `/api/v1/chat/${encodeURIComponent(trimmed)}/${params.endpoint}`,
    password
  });
  const res = await blueBubblesFetchWithTimeout(
    url,
    { method: params.method },
    params.opts.timeoutMs
  );
  await assertMultipartActionOk(res, params.action);
}
async function sendPrivateApiJsonRequest(params) {
  const { baseUrl, password, accountId } = resolveAccount(params.opts);
  assertPrivateApiEnabled(accountId, params.feature);
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: params.path,
    password
  });
  const request = { method: params.method };
  if (params.payload !== void 0) {
    request.headers = { "Content-Type": "application/json" };
    request.body = JSON.stringify(params.payload);
  }
  const res = await blueBubblesFetchWithTimeout(url, request, params.opts.timeoutMs);
  await assertMultipartActionOk(res, params.action);
}
async function markBlueBubblesChatRead(chatGuid, opts = {}) {
  await sendBlueBubblesChatEndpointRequest({
    chatGuid,
    opts,
    endpoint: "read",
    method: "POST",
    action: "read"
  });
}
async function sendBlueBubblesTyping(chatGuid, typing, opts = {}) {
  await sendBlueBubblesChatEndpointRequest({
    chatGuid,
    opts,
    endpoint: "typing",
    method: typing ? "POST" : "DELETE",
    action: "typing"
  });
}
async function editBlueBubblesMessage(messageGuid, newText, opts = {}) {
  const trimmedGuid = messageGuid.trim();
  if (!trimmedGuid) {
    throw new Error("BlueBubbles edit requires messageGuid");
  }
  const trimmedText = newText.trim();
  if (!trimmedText) {
    throw new Error("BlueBubbles edit requires newText");
  }
  await sendPrivateApiJsonRequest({
    opts,
    feature: "edit",
    action: "edit",
    method: "POST",
    path: `/api/v1/message/${encodeURIComponent(trimmedGuid)}/edit`,
    payload: {
      editedMessage: trimmedText,
      backwardsCompatibilityMessage: opts.backwardsCompatMessage ?? `Edited to: ${trimmedText}`,
      partIndex: resolvePartIndex(opts.partIndex)
    }
  });
}
async function unsendBlueBubblesMessage(messageGuid, opts = {}) {
  const trimmedGuid = messageGuid.trim();
  if (!trimmedGuid) {
    throw new Error("BlueBubbles unsend requires messageGuid");
  }
  await sendPrivateApiJsonRequest({
    opts,
    feature: "unsend",
    action: "unsend",
    method: "POST",
    path: `/api/v1/message/${encodeURIComponent(trimmedGuid)}/unsend`,
    payload: { partIndex: resolvePartIndex(opts.partIndex) }
  });
}
async function renameBlueBubblesChat(chatGuid, displayName, opts = {}) {
  const trimmedGuid = chatGuid.trim();
  if (!trimmedGuid) {
    throw new Error("BlueBubbles rename requires chatGuid");
  }
  await sendPrivateApiJsonRequest({
    opts,
    feature: "renameGroup",
    action: "rename",
    method: "PUT",
    path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}`,
    payload: { displayName }
  });
}
async function addBlueBubblesParticipant(chatGuid, address, opts = {}) {
  const trimmedGuid = chatGuid.trim();
  if (!trimmedGuid) {
    throw new Error("BlueBubbles addParticipant requires chatGuid");
  }
  const trimmedAddress = address.trim();
  if (!trimmedAddress) {
    throw new Error("BlueBubbles addParticipant requires address");
  }
  await sendPrivateApiJsonRequest({
    opts,
    feature: "addParticipant",
    action: "addParticipant",
    method: "POST",
    path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}/participant`,
    payload: { address: trimmedAddress }
  });
}
async function removeBlueBubblesParticipant(chatGuid, address, opts = {}) {
  const trimmedGuid = chatGuid.trim();
  if (!trimmedGuid) {
    throw new Error("BlueBubbles removeParticipant requires chatGuid");
  }
  const trimmedAddress = address.trim();
  if (!trimmedAddress) {
    throw new Error("BlueBubbles removeParticipant requires address");
  }
  await sendPrivateApiJsonRequest({
    opts,
    feature: "removeParticipant",
    action: "removeParticipant",
    method: "DELETE",
    path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}/participant`,
    payload: { address: trimmedAddress }
  });
}
async function leaveBlueBubblesChat(chatGuid, opts = {}) {
  const trimmedGuid = chatGuid.trim();
  if (!trimmedGuid) {
    throw new Error("BlueBubbles leaveChat requires chatGuid");
  }
  await sendPrivateApiJsonRequest({
    opts,
    feature: "leaveGroup",
    action: "leaveChat",
    method: "POST",
    path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}/leave`
  });
}
async function setGroupIconBlueBubbles(chatGuid, buffer, filename, opts = {}) {
  const trimmedGuid = chatGuid.trim();
  if (!trimmedGuid) {
    throw new Error("BlueBubbles setGroupIcon requires chatGuid");
  }
  if (!buffer || buffer.length === 0) {
    throw new Error("BlueBubbles setGroupIcon requires image buffer");
  }
  const { baseUrl, password, accountId } = resolveAccount(opts);
  assertPrivateApiEnabled(accountId, "setGroupIcon");
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}/icon`,
    password
  });
  const boundary = `----BlueBubblesFormBoundary${crypto.randomUUID().replace(/-/g, "")}`;
  const parts = [];
  const encoder = new TextEncoder();
  const safeFilename = path.basename(filename).replace(/[\r\n"\\]/g, "_") || "icon.png";
  parts.push(encoder.encode(`--${boundary}\r
`));
  parts.push(
    encoder.encode(`Content-Disposition: form-data; name="icon"; filename="${safeFilename}"\r
`)
  );
  parts.push(
    encoder.encode(`Content-Type: ${opts.contentType ?? "application/octet-stream"}\r
\r
`)
  );
  parts.push(buffer);
  parts.push(encoder.encode("\r\n"));
  parts.push(encoder.encode(`--${boundary}--\r
`));
  const res = await postMultipartFormData({
    url,
    boundary,
    parts,
    timeoutMs: opts.timeoutMs ?? 6e4
    // longer timeout for file uploads
  });
  await assertMultipartActionOk(res, "setGroupIcon");
}
export {
  addBlueBubblesParticipant,
  editBlueBubblesMessage,
  leaveBlueBubblesChat,
  markBlueBubblesChatRead,
  removeBlueBubblesParticipant,
  renameBlueBubblesChat,
  sendBlueBubblesTyping,
  setGroupIconBlueBubbles,
  unsendBlueBubblesMessage
};
