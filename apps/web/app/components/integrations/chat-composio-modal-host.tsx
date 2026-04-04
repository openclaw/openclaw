"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ComposioConnectModal } from "./composio-connect-modal";
import type {
  ComposioConnection,
  ComposioConnectionsResponse,
  ComposioToolkit,
  ComposioToolkitsResponse,
} from "@/lib/composio";
import {
  extractComposioConnections,
  extractComposioToolkits,
} from "@/lib/composio-client";
import {
  normalizeComposioToolkitName,
  normalizeComposioToolkitSlug,
  resolveComposioConnectToolkitSlug,
} from "@/lib/composio-normalization";
import type { ComposioChatAction } from "@/lib/composio-chat-actions";

function createToolkitPlaceholder(slug: string, name?: string | null): ComposioToolkit {
  const fallbackName = normalizeComposioToolkitName(undefined, slug);
  return {
    slug: normalizeComposioToolkitSlug(slug),
    connect_slug: resolveComposioConnectToolkitSlug(slug),
    name: typeof name === "string" && name.trim().length > 0
      ? name.trim()
      : fallbackName.includes("-")
        ? fallbackName.split("-").map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(" ")
        : fallbackName.charAt(0).toUpperCase() + fallbackName.slice(1),
    description: "",
    logo: null,
    categories: [],
    auth_schemes: [],
    tools_count: 0,
  };
}

function pickToolkitMatch(toolkits: ComposioToolkit[], slug: string, name?: string | null): ComposioToolkit | null {
  const normalizedSlug = normalizeComposioToolkitSlug(slug);
  const normalizedName = name?.trim().toLowerCase() ?? "";

  return toolkits.find((toolkit) =>
    normalizeComposioToolkitSlug(toolkit.slug) === normalizedSlug
    || (normalizedName.length > 0 && toolkit.name.trim().toLowerCase() === normalizedName),
  ) ?? null;
}

async function resolveModalData(toolkitSlug: string, toolkitName?: string | null): Promise<{
  toolkit: ComposioToolkit | null;
  connections: ComposioConnection[];
}> {
  const normalizedSlug = normalizeComposioToolkitSlug(toolkitSlug);
  let toolkit: ComposioToolkit | null = null;
  let connections: ComposioConnection[] = [];

  const connectionsResponse = await fetch("/api/composio/connections?include_toolkits=1&fresh=1");
  if (connectionsResponse.ok) {
    const connectionsPayload = await connectionsResponse.json() as ComposioConnectionsResponse & {
      toolkits?: ComposioToolkit[];
    };
    connections = extractComposioConnections(connectionsPayload).filter((connection) =>
      normalizeComposioToolkitSlug(connection.toolkit_slug) === normalizedSlug,
    );
    toolkit = pickToolkitMatch(
      Array.isArray(connectionsPayload.toolkits) ? connectionsPayload.toolkits : [],
      normalizedSlug,
      toolkitName,
    );
  }

  if (!toolkit) {
    const search = new URLSearchParams({
      search: toolkitName?.trim() || normalizedSlug,
      limit: "24",
    });
    const toolkitResponse = await fetch(`/api/composio/toolkits?${search.toString()}`);
    if (toolkitResponse.ok) {
      const toolkitPayload = await toolkitResponse.json() as ComposioToolkitsResponse;
      toolkit = pickToolkitMatch(
        extractComposioToolkits(toolkitPayload).items,
        normalizedSlug,
        toolkitName,
      );
    }
  }

  return { toolkit, connections };
}

export function ChatComposioModalHost({
  request,
  onFallbackToIntegrations,
}: {
  request: ComposioChatAction | null;
  onFallbackToIntegrations: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [toolkit, setToolkit] = useState<ComposioToolkit | null>(null);
  const [connections, setConnections] = useState<ComposioConnection[]>([]);
  const [preferredAction, setPreferredAction] = useState<ComposioChatAction["action"]>("connect");
  const requestVersionRef = useRef(0);

  const hydrateModalTarget = useCallback(async (
    nextRequest: ComposioChatAction,
    options?: { openModal?: boolean },
  ) => {
    const rawToolkitSlug = nextRequest.toolkitSlug?.trim();
    if (!rawToolkitSlug) {
      setOpen(false);
      setToolkit(null);
      setConnections([]);
      onFallbackToIntegrations();
      return;
    }

    const normalizedSlug = normalizeComposioToolkitSlug(rawToolkitSlug);
    const placeholder = createToolkitPlaceholder(normalizedSlug, nextRequest.toolkitName);
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    setPreferredAction(nextRequest.action);
    if (options?.openModal !== false) {
      setToolkit(placeholder);
      setConnections([]);
      setOpen(true);
    }

    try {
      const resolved = await resolveModalData(normalizedSlug, nextRequest.toolkitName);
      if (requestVersion !== requestVersionRef.current) {
        return;
      }
      setToolkit(resolved.toolkit ?? placeholder);
      setConnections(resolved.connections);
    } catch {
      if (requestVersion !== requestVersionRef.current) {
        return;
      }
      setToolkit((current) => current ?? placeholder);
    }
  }, [onFallbackToIntegrations]);

  useEffect(() => {
    if (!request) {
      return;
    }
    void hydrateModalTarget(request);
  }, [hydrateModalTarget, request]);

  const handleConnectionChange = useCallback((payload?: {
    toolkit?: ComposioToolkit | null;
    connected?: boolean;
    connectedToolkitSlug?: string | null;
    connectedToolkitName?: string | null;
    shouldProbeLiveAgent?: boolean;
  }) => {
    const nextToolkitSlug = payload?.connectedToolkitSlug
      ?? payload?.toolkit?.slug
      ?? toolkit?.slug
      ?? null;
    if (!nextToolkitSlug) {
      return;
    }
    void hydrateModalTarget(
      {
        action: preferredAction,
        toolkitSlug: nextToolkitSlug,
        toolkitName:
          payload?.connectedToolkitName
          ?? payload?.toolkit?.name
          ?? toolkit?.name
          ?? null,
      },
      { openModal: false },
    );
  }, [hydrateModalTarget, preferredAction, toolkit?.name, toolkit?.slug]);

  return (
    <ComposioConnectModal
      toolkit={toolkit}
      connections={connections}
      open={open}
      preferredAction={preferredAction}
      onOpenChange={setOpen}
      onConnectionChange={handleConnectionChange}
    />
  );
}
