const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const GRAPH_BETA = "https://graph.microsoft.com/beta";
const GRAPH_SCOPE = "https://graph.microsoft.com";
function parseUploadedDriveItem(data, label) {
  if (!data.id || !data.webUrl || !data.name) {
    throw new Error(`${label} upload response missing required fields`);
  }
  return {
    id: data.id,
    webUrl: data.webUrl,
    name: data.name
  };
}
async function uploadDriveItem(params) {
  const fetchFn = params.fetchFn ?? fetch;
  const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);
  const res = await fetchFn(params.url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": params.contentType ?? "application/octet-stream"
    },
    body: new Uint8Array(params.buffer)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${params.label} upload failed: ${res.status} ${res.statusText} - ${body}`);
  }
  return parseUploadedDriveItem(
    await res.json(),
    params.label
  );
}
async function uploadToOneDrive(params) {
  const uploadPath = `/OpenClawShared/${encodeURIComponent(params.filename)}`;
  return await uploadDriveItem({
    ...params,
    url: `${GRAPH_ROOT}/me/drive/root:${uploadPath}:/content`,
    label: "OneDrive"
  });
}
async function createSharingLink(params) {
  const fetchFn = params.fetchFn ?? fetch;
  const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);
  const res = await fetchFn(`${GRAPH_ROOT}/me/drive/items/${params.itemId}/createLink`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      type: "view",
      scope: params.scope ?? "organization"
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Create sharing link failed: ${res.status} ${res.statusText} - ${body}`);
  }
  const data = await res.json();
  if (!data.link?.webUrl) {
    throw new Error("Create sharing link response missing webUrl");
  }
  return {
    webUrl: data.link.webUrl
  };
}
async function uploadAndShareOneDrive(params) {
  const uploaded = await uploadToOneDrive({
    buffer: params.buffer,
    filename: params.filename,
    contentType: params.contentType,
    tokenProvider: params.tokenProvider,
    fetchFn: params.fetchFn
  });
  const shareLink = await createSharingLink({
    itemId: uploaded.id,
    tokenProvider: params.tokenProvider,
    scope: params.scope,
    fetchFn: params.fetchFn
  });
  return {
    itemId: uploaded.id,
    webUrl: uploaded.webUrl,
    shareUrl: shareLink.webUrl,
    name: uploaded.name
  };
}
async function uploadToSharePoint(params) {
  const uploadPath = `/OpenClawShared/${encodeURIComponent(params.filename)}`;
  return await uploadDriveItem({
    ...params,
    url: `${GRAPH_ROOT}/sites/${params.siteId}/drive/root:${uploadPath}:/content`,
    label: "SharePoint"
  });
}
async function getDriveItemProperties(params) {
  const fetchFn = params.fetchFn ?? fetch;
  const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);
  const res = await fetchFn(
    `${GRAPH_ROOT}/sites/${params.siteId}/drive/items/${params.itemId}?$select=eTag,webDavUrl,name`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Get driveItem properties failed: ${res.status} ${res.statusText} - ${body}`);
  }
  const data = await res.json();
  if (!data.eTag || !data.webDavUrl || !data.name) {
    throw new Error("DriveItem response missing required properties (eTag, webDavUrl, or name)");
  }
  return {
    eTag: data.eTag,
    webDavUrl: data.webDavUrl,
    name: data.name
  };
}
async function getChatMembers(params) {
  const fetchFn = params.fetchFn ?? fetch;
  const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);
  const res = await fetchFn(`${GRAPH_ROOT}/chats/${params.chatId}/members`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Get chat members failed: ${res.status} ${res.statusText} - ${body}`);
  }
  const data = await res.json();
  return (data.value ?? []).map((m) => ({
    aadObjectId: m.userId ?? "",
    displayName: m.displayName
  })).filter((m) => m.aadObjectId);
}
async function createSharePointSharingLink(params) {
  const fetchFn = params.fetchFn ?? fetch;
  const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);
  const scope = params.scope ?? "organization";
  const apiRoot = scope === "users" ? GRAPH_BETA : GRAPH_ROOT;
  const body = {
    type: "view",
    scope: scope === "users" ? "users" : "organization"
  };
  if (scope === "users" && params.recipientObjectIds?.length) {
    body.recipients = params.recipientObjectIds.map((id) => ({ objectId: id }));
  }
  const res = await fetchFn(
    `${apiRoot}/sites/${params.siteId}/drive/items/${params.itemId}/createLink`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
  if (!res.ok) {
    const respBody = await res.text().catch(() => "");
    throw new Error(
      `Create SharePoint sharing link failed: ${res.status} ${res.statusText} - ${respBody}`
    );
  }
  const data = await res.json();
  if (!data.link?.webUrl) {
    throw new Error("Create SharePoint sharing link response missing webUrl");
  }
  return {
    webUrl: data.link.webUrl
  };
}
async function uploadAndShareSharePoint(params) {
  const uploaded = await uploadToSharePoint({
    buffer: params.buffer,
    filename: params.filename,
    contentType: params.contentType,
    tokenProvider: params.tokenProvider,
    siteId: params.siteId,
    fetchFn: params.fetchFn
  });
  let scope = "organization";
  let recipientObjectIds;
  if (params.usePerUserSharing && params.chatId) {
    try {
      const members = await getChatMembers({
        chatId: params.chatId,
        tokenProvider: params.tokenProvider,
        fetchFn: params.fetchFn
      });
      if (members.length > 0) {
        scope = "users";
        recipientObjectIds = members.map((m) => m.aadObjectId);
      }
    } catch {
    }
  }
  const shareLink = await createSharePointSharingLink({
    siteId: params.siteId,
    itemId: uploaded.id,
    tokenProvider: params.tokenProvider,
    scope,
    recipientObjectIds,
    fetchFn: params.fetchFn
  });
  return {
    itemId: uploaded.id,
    webUrl: uploaded.webUrl,
    shareUrl: shareLink.webUrl,
    name: uploaded.name
  };
}
export {
  createSharePointSharingLink,
  createSharingLink,
  getChatMembers,
  getDriveItemProperties,
  uploadAndShareOneDrive,
  uploadAndShareSharePoint,
  uploadToOneDrive,
  uploadToSharePoint
};
