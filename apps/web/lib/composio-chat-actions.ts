export type ComposioChatAction = {
  action: "connect" | "reconnect";
  toolkitSlug?: string | null;
  toolkitName?: string | null;
};

function readSearchParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function buildComposioChatActionHref(action: ComposioChatAction["action"], params?: {
  toolkitSlug?: string | null;
  toolkitName?: string | null;
}): string {
  const search = new URLSearchParams();
  if (params?.toolkitSlug?.trim()) {
    search.set("toolkit", params.toolkitSlug.trim());
  }
  if (params?.toolkitName?.trim()) {
    search.set("name", params.toolkitName.trim());
  }
  const query = search.toString();
  return `dench://composio/${action}${query ? `?${query}` : ""}`;
}

export function parseComposioChatAction(href: string): ComposioChatAction | null {
  const trimmed = href.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "dench:" || parsed.hostname !== "composio") {
    return null;
  }

  const action = parsed.pathname.replace(/^\/+|\/+$/g, "");
  if (action !== "connect" && action !== "reconnect") {
    return null;
  }

  return {
    action,
    toolkitSlug: readSearchParam(parsed.searchParams, "toolkit"),
    toolkitName: readSearchParam(parsed.searchParams, "name"),
  };
}
