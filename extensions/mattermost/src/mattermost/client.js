function normalizeMattermostBaseUrl(raw) {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return void 0;
  }
  const withoutTrailing = trimmed.replace(/\/+$/, "");
  return withoutTrailing.replace(/\/api\/v4$/i, "");
}
function buildMattermostApiUrl(baseUrl, path) {
  const normalized = normalizeMattermostBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("Mattermost baseUrl is required");
  }
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${normalized}/api/v4${suffix}`;
}
async function readMattermostError(res) {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = await res.json();
    if (data?.message) {
      return data.message;
    }
    return JSON.stringify(data);
  }
  return await res.text();
}
function createMattermostClient(params) {
  const baseUrl = normalizeMattermostBaseUrl(params.baseUrl);
  if (!baseUrl) {
    throw new Error("Mattermost baseUrl is required");
  }
  const apiBaseUrl = `${baseUrl}/api/v4`;
  const token = params.botToken.trim();
  const fetchImpl = params.fetchImpl ?? fetch;
  const request = async (path, init) => {
    const url = buildMattermostApiUrl(baseUrl, path);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (typeof init?.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetchImpl(url, { ...init, headers });
    if (!res.ok) {
      const detail = await readMattermostError(res);
      throw new Error(
        `Mattermost API ${res.status} ${res.statusText}: ${detail || "unknown error"}`
      );
    }
    if (res.status === 204) {
      return void 0;
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return await res.json();
    }
    return await res.text();
  };
  return { baseUrl, apiBaseUrl, token, request };
}
async function fetchMattermostMe(client) {
  return await client.request("/users/me");
}
async function fetchMattermostUser(client, userId) {
  return await client.request(`/users/${userId}`);
}
async function fetchMattermostUserByUsername(client, username) {
  return await client.request(`/users/username/${encodeURIComponent(username)}`);
}
async function fetchMattermostChannel(client, channelId) {
  return await client.request(`/channels/${channelId}`);
}
async function fetchMattermostChannelByName(client, teamId, channelName) {
  return await client.request(
    `/teams/${teamId}/channels/name/${encodeURIComponent(channelName)}`
  );
}
async function sendMattermostTyping(client, params) {
  const payload = {
    channel_id: params.channelId
  };
  const parentId = params.parentId?.trim();
  if (parentId) {
    payload.parent_id = parentId;
  }
  await client.request("/users/me/typing", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}
async function createMattermostDirectChannel(client, userIds) {
  return await client.request("/channels/direct", {
    method: "POST",
    body: JSON.stringify(userIds)
  });
}
async function createMattermostPost(client, params) {
  const payload = {
    channel_id: params.channelId,
    message: params.message
  };
  if (params.rootId) {
    payload.root_id = params.rootId;
  }
  if (params.fileIds?.length) {
    payload.file_ids = params.fileIds;
  }
  if (params.props) {
    payload.props = params.props;
  }
  return await client.request("/posts", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}
async function fetchMattermostUserTeams(client, userId) {
  return await client.request(`/users/${userId}/teams`);
}
async function updateMattermostPost(client, postId, params) {
  const payload = { id: postId };
  if (params.message !== void 0) {
    payload.message = params.message;
  }
  if (params.props !== void 0) {
    payload.props = params.props;
  }
  return await client.request(`/posts/${postId}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}
async function uploadMattermostFile(client, params) {
  const form = new FormData();
  const fileName = params.fileName?.trim() || "upload";
  const bytes = Uint8Array.from(params.buffer);
  const blob = params.contentType ? new Blob([bytes], { type: params.contentType }) : new Blob([bytes]);
  form.append("files", blob, fileName);
  form.append("channel_id", params.channelId);
  const res = await fetch(`${client.apiBaseUrl}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${client.token}`
    },
    body: form
  });
  if (!res.ok) {
    const detail = await readMattermostError(res);
    throw new Error(`Mattermost API ${res.status} ${res.statusText}: ${detail || "unknown error"}`);
  }
  const data = await res.json();
  const info = data.file_infos?.[0];
  if (!info?.id) {
    throw new Error("Mattermost file upload failed");
  }
  return info;
}
export {
  createMattermostClient,
  createMattermostDirectChannel,
  createMattermostPost,
  fetchMattermostChannel,
  fetchMattermostChannelByName,
  fetchMattermostMe,
  fetchMattermostUser,
  fetchMattermostUserByUsername,
  fetchMattermostUserTeams,
  normalizeMattermostBaseUrl,
  readMattermostError,
  sendMattermostTyping,
  updateMattermostPost,
  uploadMattermostFile
};
