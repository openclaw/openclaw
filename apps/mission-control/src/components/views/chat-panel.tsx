"use client";

import { useState, useEffect, useRef, useCallback, useMemo, type ChangeEvent } from "react";
import {
  Send,
  Plus,
  Bot,
  User,
  Loader2,
  RefreshCw,
  ArrowDown,
  Square,
  Clock3,
  Trash2,
  Copy,
  RotateCcw,
  Check,
  Sparkles,
  Search,
  SlidersHorizontal,
  Tag,
  X,
} from "lucide-react";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import {
  useGatewayEvents,
  type GatewayEvent,
} from "@/lib/hooks/use-gateway-events";
import {
  FileAttachments,
  type FileAttachmentsRef,
} from "@/components/chat/file-attachments";
import type { FileAttachment } from "@/lib/file-utils";

interface ChatMessage {
  role: string;
  content: unknown;
  timestamp?: string | number;
  errorMessage?: string;
  stopReason?: string;
  provider?: string;
  model?: string;
  runId?: string;
}

interface ChatApiResponse {
  error?: string;
  reply?: ChatMessage | null;
  queued?: boolean;
  runId?: string | null;
  status?: string;
  fallbackModel?: string | null;
  warning?: string | null;
  messages?: ChatMessage[];
}

interface GatewayChatPayload {
  runId?: string;
  sessionKey?: string;
  state?: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
}

interface ChatSession {
  key: string;
  label: string;
  model?: string | null;
  provider?: string | null;
  totalTokens?: number;
  lastActivity?: string | null;
}

interface SessionsApiResponse {
  error?: string;
  sessions?: ChatSession[];
}

interface ChatSearchResultRow {
  id: string;
  entryId: string;
  sessionKey: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: number;
  model?: string | null;
  provider?: string | null;
  channel?: string | null;
  accountId?: string | null;
  agentId?: string | null;
  parentId?: string | null;
  sessionTitle?: string | null;
}

interface ChatSearchApiResponse {
  error?: string;
  results?: ChatSearchResultRow[];
  nextOffset?: number;
  warning?: string | null;
}

interface SessionsSearchResultRow {
  sessionKey: string;
  sessionId: string;
  title?: string | null;
  updatedAt?: number | null;
  channel?: string | null;
  accountId?: string | null;
  agentId?: string | null;
  matches: number;
  lastMessageAt?: number | null;
}

interface SessionsSearchApiResponse {
  error?: string;
  results?: SessionsSearchResultRow[];
  nextOffset?: number;
  warning?: string | null;
}

interface ModelOption {
  id: string;
  name?: string;
  provider?: string;
  selectable?: boolean;
  modelRef?: string;
  tier?: string;
  tierRank?: number;
  badge?: string;
  label?: string;
}

interface ModelsApiResponse {
  error?: string;
  models?: ModelOption[];
}

interface UploadedAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  category: string;
  language: string | null;
  textPreview: string | null;
}

interface AttachmentsApiResponse {
  error?: string;
  attachments?: UploadedAttachment[];
}

interface CouncilResult {
  model: string;
  sessionKey: string;
  ok: boolean;
  message?: string;
  timestamp?: string;
  error?: string;
}

interface CouncilApiResponse {
  error?: string;
  results?: CouncilResult[];
}

interface TagsApiResponse {
  error?: string;
  tags?: string[];
}

const DEFAULT_SESSION_KEY = "agent:main:mission-control:chat";
const SESSION_PREFIX = "agent:main:";
const BOTTOM_THRESHOLD_PX = 48;
const MESSAGE_RENDER_WINDOW = 80;
const MESSAGE_RENDER_STEP = 60;
const ATTACHMENT_CONTEXT_SENTINEL = "[[MC_ATTACHMENT_CONTEXT]]";

function cleanText(text: string): string {
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  cleaned = cleaned.replace(/<\/?final>/gi, "");
  const markerIndex = cleaned.indexOf(ATTACHMENT_CONTEXT_SENTINEL);
  if (markerIndex >= 0) {
    cleaned = cleaned.slice(0, markerIndex);
  } else {
    cleaned = cleaned.replace(/\n---\nAttached files context:[\s\S]*$/i, "");
  }
  return cleaned.trim();
}

function extractText(content: unknown): string {
  if (typeof content === "string") return cleanText(content);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && typeof block === "object") {
        const record = block as Record<string, unknown>;
        if (typeof record.text === "string") {
          parts.push(record.text);
        } else if (record.content) {
          const inner = extractText(record.content);
          if (inner) parts.push(inner);
        }
      }
    }
    return cleanText(parts.join("\n"));
  }
  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return cleanText(obj.text);
    if (obj.content) return extractText(obj.content);
  }
  return cleanText(String(content ?? ""));
}

function normalizeErrorMessage(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) return "Agent failed to respond.";

  const objectStart = text.indexOf("{");
  if (objectStart >= 0) {
    const candidate = text.slice(objectStart);
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      let message: string | null = null;
      if (
        parsed.error &&
        typeof parsed.error === "object" &&
        typeof (parsed.error as Record<string, unknown>).message === "string"
      ) {
        message = (parsed.error as Record<string, unknown>).message as string;
      } else if (typeof parsed.message === "string") {
        message = parsed.message;
      }
      if (message) return message;
    } catch {
      // Ignore parse errors and continue with keyword mapping.
    }
  }

  const lower = text.toLowerCase();
  if (lower.includes("invalid x-api-key") || lower.includes("authentication_error")) {
    return "Model provider authentication failed. Update provider keys or switch models.";
  }
  if (lower.includes("credit balance is too low") || lower.includes("plans & billing")) {
    return "Provider credits are insufficient. Switch model/provider or top up credits.";
  }

  return text.length > 260 ? `${text.slice(0, 257)}...` : text;
}

function formatMessageTime(value: string | number | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return "No activity";
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return "No activity";

  const diffMs = Date.now() - ts;
  const diffMin = Math.floor(diffMs / (1000 * 60));
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;

  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatRelativeFromTimestamp(value: number | null | undefined): string {
  if (!value) return "Unknown";
  const iso = new Date(value).toISOString();
  return formatRelativeTime(iso);
}

function truncateText(text: string, max = 140): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function parseTagsInput(raw: string): string[] {
  return raw
    .split(",")
    .map((tag) => tag.trim().replace(/^#/, "").toLowerCase())
    .filter(Boolean);
}

function compactSessionLabel(key: string): string {
  const label = key.startsWith(SESSION_PREFIX)
    ? key.slice(SESSION_PREFIX.length)
    : key;
  if (!label) return "Session";

  // Clean up raw key labels like "mission-control:chat-1739812345678"
  const chatMatch = label.match(/^mission-control:chat(?:-(\d+))?$/);
  if (chatMatch) {
    const ts = chatMatch[1] ? Number(chatMatch[1]) : 0;
    if (ts > 0) {
      const date = new Date(ts);
      if (!Number.isNaN(date.getTime())) {
        return `Chat ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      }
    }
    return "Main Chat";
  }

  // Clean up e2e test sessions
  if (label.includes("e2e")) {
    return "Test Session";
  }

  return label.length > 36 ? `${label.slice(0, 33)}...` : label;
}

function generateSessionTitle(message: string): string {
  const cleaned = message.replace(/\n/g, " ").trim();
  if (cleaned.length <= 60) return cleaned;
  const truncated = cleaned.slice(0, 60);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > 30 ? `${truncated.slice(0, lastSpace)}...` : `${truncated}...`;
}

function formatElapsedTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function toModelRef(model: ModelOption): string {
  const modelId = (model.modelRef || model.id || "").trim();
  if (!modelId) return "";
  return modelId;
}

function toModelLabel(model: ModelOption): string {
  // Prefer curated label from catalog
  if (model.label) {
    const suffix = model.badge ? ` (${model.badge})` : "";
    return `${model.label}${suffix}`;
  }
  const modelId = (model.id || "").trim();
  if (!modelId) return "";
  if (!model.provider) return modelId;
  return modelId.startsWith(`${model.provider}/`)
    ? modelId
    : `${model.provider}/${modelId}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildAttachmentContext(attachments: UploadedAttachment[]): string {
  if (attachments.length === 0) return "";

  const lines: string[] = [
    "",
    ATTACHMENT_CONTEXT_SENTINEL,
    "Attached files context:",
  ];

  attachments.forEach((attachment, index) => {
    lines.push(
      `[${index + 1}] ${attachment.name} (${attachment.category}, ${formatBytes(
        attachment.size
      )})`
    );
    if (attachment.textPreview) {
      const preview = attachment.textPreview.slice(0, 2000);
      lines.push("Preview:");
      lines.push(preview);
      lines.push("");
    }
  });

  return lines.join("\n").trim();
}

function formatCouncilSummary(results: CouncilResult[]): string {
  if (results.length === 0) return "Council mode ran, but no model responses were returned.";

  const lines: string[] = ["Council results:"];
  for (const result of results) {
    if (!result.ok) {
      lines.push(`- ${result.model}: failed (${normalizeErrorMessage(result.error)})`);
      continue;
    }

    const summary = cleanText(result.message || "").slice(0, 500);
    lines.push(`- ${result.model}: ${summary || "(empty response)"}`);
  }

  return lines.join("\n");
}

export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchView, setSearchView] = useState<"messages" | "sessions">("messages");
  const [searchResults, setSearchResults] = useState<ChatSearchResultRow[]>([]);
  const [searchSessions, setSearchSessions] = useState<SessionsSearchResultRow[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchFiltersOpen, setSearchFiltersOpen] = useState(false);
  const [searchChannel, setSearchChannel] = useState("");
  const [searchTagsDraft, setSearchTagsDraft] = useState("");
  const [searchRange, setSearchRange] = useState<"24h" | "7d" | "30d" | "all">("30d");
  const [sessionTags, setSessionTags] = useState<string[]>([]);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [tagsEditing, setTagsEditing] = useState(false);
  const [tagsDraft, setTagsDraft] = useState("");

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [awaitingFinal, setAwaitingFinal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [streamingRunId, setStreamingRunId] = useState<string | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(false);
  const [hasUnseenUpdates, setHasUnseenUpdates] = useState(false);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [sessionBusyKey, setSessionBusyKey] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_SESSION_KEY;
    const fromUrl = new URLSearchParams(window.location.search).get("chatSession");
    if (!fromUrl) return DEFAULT_SESSION_KEY;
    try {
      return decodeURIComponent(fromUrl);
    } catch {
      return fromUrl;
    }
  });
  const [composerAttachments, setComposerAttachments] = useState<FileAttachment[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [councilEnabled, setCouncilEnabled] = useState(false);
  const [councilModels, setCouncilModels] = useState<string[]>([]);
  const [councilRunning, setCouncilRunning] = useState(false);
  const [copiedShare, setCopiedShare] = useState(false);
  const [visibleStartIndex, setVisibleStartIndex] = useState(0);
  const [workingElapsed, setWorkingElapsed] = useState(0);
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attachmentsRef = useRef<FileAttachmentsRef>(null);
  const lastRenderCountRef = useRef(0);
  const prependScrollAnchorRef = useRef<{ top: number; height: number } | null>(
    null
  );
  const shouldAutoScrollRef = useRef(true);
  const resetWindowRef = useRef(true);

  const isNearBottom = useCallback((el: HTMLDivElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    shouldAutoScrollRef.current = true;
    setIsAtBottom(true);
    setHasUnseenUpdates(false);
  }, []);

  const conversationMessages = useMemo(
    () =>
      messages.filter((m) => m.role === "user" || m.role === "assistant"),
    [messages]
  );
  const renderedMessages = useMemo(
    () => conversationMessages.slice(visibleStartIndex),
    [conversationMessages, visibleStartIndex]
  );
  const hiddenMessageCount = Math.max(0, visibleStartIndex);

  const fetchHistory = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(
        `/api/chat?sessionKey=${encodeURIComponent(sessionKey)}&limit=200`
      );
      const data = (await res.json()) as ChatApiResponse;
      if (!res.ok) {
        setError(normalizeErrorMessage(data.error || `Request failed (${res.status})`));
        return;
      }
      if (Array.isArray(data.messages)) {
        const nextMessages = data.messages;
        setMessages(nextMessages);
        setVisibleStartIndex((prev) => {
          const nextWindowStart = Math.max(
            0,
            nextMessages.length - MESSAGE_RENDER_WINDOW
          );
          if (resetWindowRef.current) {
            resetWindowRef.current = false;
            return nextWindowStart;
          }
          return Math.min(prev, nextWindowStart);
        });

        // Retroactively generate title for sessions that still have raw key labels
        setSessions((prev) => {
          const session = prev.find((s) => s.key === sessionKey);
          if (!session) return prev;
          // If session already has a meaningful title (not a raw key pattern), skip
          const lbl = session.label || "";
          const isRawKey =
            !lbl || lbl.startsWith("mission-control:") || lbl.startsWith("agent:main:");
          if (!isRawKey) return prev;
          // Find first user message to derive title
          const firstUser = nextMessages.find((m) => m.role === "user");
          if (!firstUser) return prev;
          const text = extractText(firstUser.content);
          if (!text) return prev;
          const title = generateSessionTitle(text);
          // Persist to backend (fire-and-forget)
          void fetch("/api/chat/sessions", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionKey, label: title }),
          }).catch(() => { });
          return prev.map((s) =>
            s.key === sessionKey ? { ...s, label: title } : s
          );
        });
      } else {
        setMessages([]);
        setVisibleStartIndex(0);
      }
      setError(null);
    } catch (err) {
      setError(normalizeErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [sessionKey]);

  const fetchSessions = useCallback(async () => {
    try {
      setSessionsLoading(true);
      const res = await fetch("/api/chat/sessions?limit=60");
      const data = (await res.json()) as SessionsApiResponse;
      if (!res.ok) {
        setError(normalizeErrorMessage(data.error || `Request failed (${res.status})`));
        return;
      }
      setSessions(Array.isArray(data.sessions) ? data.sessions : []);
    } catch (err) {
      setError(normalizeErrorMessage(err));
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const fetchModels = useCallback(async () => {
    try {
      setModelsLoading(true);
      const res = await fetch("/api/models");
      const data = (await res.json()) as ModelsApiResponse;
      if (!res.ok || data.error) {
        return;
      }
      setModels(Array.isArray(data.models) ? data.models : []);
    } catch {
      // Model picker is optional, so keep chat usable if this request fails.
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const fetchSessionTags = useCallback(async () => {
    setTagsLoading(true);
    try {
      const res = await fetch(
        `/api/chat/tags?sessionKey=${encodeURIComponent(sessionKey)}`
      );
      const data = (await res.json()) as TagsApiResponse;
      if (!res.ok) {
        setSessionTags([]);
        return;
      }
      setSessionTags(Array.isArray(data.tags) ? data.tags : []);
    } catch {
      setSessionTags([]);
    } finally {
      setTagsLoading(false);
    }
  }, [sessionKey]);

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory]);

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    void fetchModels();
  }, [fetchModels]);

  useEffect(() => {
    setTagsEditing(false);
    setTagsDraft("");
    void fetchSessionTags();
  }, [fetchSessionTags]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchSessions([]);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearchLoading(true);
      setSearchError(null);
      const tags = parseTagsInput(searchTagsDraft);
      const now = Date.now();
      const rangeMs =
        searchRange === "24h"
          ? 24 * 60 * 60 * 1000
          : searchRange === "7d"
            ? 7 * 24 * 60 * 60 * 1000
            : searchRange === "30d"
              ? 30 * 24 * 60 * 60 * 1000
              : null;
      const from = rangeMs ? now - rangeMs : undefined;

      const basePayload = {
        query,
        limit: 50,
        channel: searchChannel.trim() || undefined,
        from,
        tags: tags.length > 0 ? tags : undefined,
        agentId: "main",
      };

      try {
        const [messagesRes, sessionsRes] = await Promise.all([
          fetch("/api/chat/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(basePayload),
            signal: controller.signal,
          }),
          fetch("/api/chat/sessions/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(basePayload),
            signal: controller.signal,
          }),
        ]);

        const messagesData = (await messagesRes.json()) as ChatSearchApiResponse;
        const sessionsData = (await sessionsRes.json()) as SessionsSearchApiResponse;

        if (!messagesRes.ok) {
          setSearchError(
            normalizeErrorMessage(
              messagesData.error || `Request failed (${messagesRes.status})`
            )
          );
          setSearchResults([]);
        } else {
          setSearchResults(Array.isArray(messagesData.results) ? messagesData.results : []);
        }

        if (!sessionsRes.ok) {
          setSearchSessions([]);
        } else {
          setSearchSessions(Array.isArray(sessionsData.results) ? sessionsData.results : []);
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return;
        }
        setSearchError(normalizeErrorMessage(err));
        setSearchResults([]);
        setSearchSessions([]);
      } finally {
        if (!controller.signal.aborted) {
          setSearchLoading(false);
        }
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery, searchChannel, searchTagsDraft, searchRange]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const nearBottom = isNearBottom(el);
    shouldAutoScrollRef.current = nearBottom;
    setIsAtBottom(nearBottom);
    if (nearBottom) {
      setHasUnseenUpdates(false);
    }
  }, [isNearBottom]);

  useEffect(() => {
    const rendered = renderedMessages.length + (streamingText ? 1 : 0);
    if (rendered === lastRenderCountRef.current) return;
    lastRenderCountRef.current = rendered;

    const el = scrollContainerRef.current;
    if (!el) return;

    if (prependScrollAnchorRef.current) {
      const anchor = prependScrollAnchorRef.current;
      prependScrollAnchorRef.current = null;
      const delta = el.scrollHeight - anchor.height;
      el.scrollTop = anchor.top + delta;
      setIsAtBottom(isNearBottom(el));
      return;
    }

    const nearBottom = isNearBottom(el);
    if (shouldAutoScrollRef.current || nearBottom) {
      requestAnimationFrame(() => {
        scrollToBottom("auto");
      });
      return;
    }

    setIsAtBottom(false);
    if (rendered > 0) {
      setHasUnseenUpdates(true);
    }
  }, [renderedMessages, streamingText, isNearBottom, scrollToBottom]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.key === sessionKey) ?? null,
    [sessions, sessionKey]
  );
  const searchActive = searchQuery.trim().length > 0;

  useEffect(() => {
    setActiveModel(activeSession?.model ?? null);
  }, [activeSession]);

  const displayedSessions = useMemo(() => {
    const unique: ChatSession[] = [];
    const seen = new Set<string>();

    for (const session of sessions) {
      if (!session.key || seen.has(session.key)) continue;
      seen.add(session.key);
      unique.push(session);
    }

    if (!seen.has(sessionKey)) {
      unique.unshift({
        key: sessionKey,
        label: compactSessionLabel(sessionKey),
        model: activeModel,
        provider: null,
        totalTokens: 0,
        lastActivity: null,
      });
    }

    return unique;
  }, [sessions, sessionKey, activeModel]);

  const sortedModels = useMemo(() => {
    const sourceModels =
      models.some((model) => typeof model.selectable === "boolean")
        ? models.filter((model) => model.selectable !== false)
        : models;
    const uniqueByRef = new Map<string, ModelOption>();
    for (const model of sourceModels) {
      const ref = toModelRef(model);
      if (!ref || uniqueByRef.has(ref)) continue;
      uniqueByRef.set(ref, { ...model, id: ref });
    }

    // Sort: catalog models by tier order + rank first, uncataloged last alphabetically
    const tierOrder: Record<string, number> = {
      popular: 0,
      fast: 1,
      reasoning: 2,
      coding: 3,
      budget: 4,
    };
    return Array.from(uniqueByRef.values()).sort((a, b) => {
      const aTier = tierOrder[a.tier ?? ""] ?? 99;
      const bTier = tierOrder[b.tier ?? ""] ?? 99;
      if (aTier !== bTier) return aTier - bTier;
      const aRank = a.tierRank ?? 999;
      const bRank = b.tierRank ?? 999;
      if (aRank !== bRank) return aRank - bRank;
      return (a.id || "").localeCompare(b.id || "");
    });
  }, [models]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (sessionKey === DEFAULT_SESSION_KEY) {
      url.searchParams.delete("chatSession");
    } else {
      url.searchParams.set("chatSession", sessionKey);
    }
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, [sessionKey]);

  useEffect(() => {
    const modelSet = new Set(sortedModels.map((model) => model.id));
    const next = councilModels.filter((model) => modelSet.has(model));
    if (next.length === 0 && sortedModels.length > 0) {
      const defaults = sortedModels
        .slice(0, Math.min(3, sortedModels.length))
        .map((model) => model.id);
      setCouncilModels(defaults);
      return;
    }
    if (next.length !== councilModels.length) {
      setCouncilModels(next);
    }
  }, [councilModels, sortedModels]);

  const handleGatewayEvent = useCallback(
    (event: GatewayEvent) => {
      if (event.type !== "gateway_event") return;
      if (event.event !== "chat") return;

      const payload = (event.payload || {}) as GatewayChatPayload;
      if (!payload.sessionKey || payload.sessionKey !== sessionKey) return;

      const state = payload.state;
      const runId = typeof payload.runId === "string" ? payload.runId : null;

      if (state === "delta") {
        setSending(false);
        setAwaitingFinal(true);
        if (runId) setStreamingRunId(runId);

        const next = extractText(payload.message);
        if (!next) return;
        setStreamingText((prev) => (next.length >= prev.length ? next : prev));
        return;
      }

      if (state === "final") {
        setSending(false);
        setAwaitingFinal(false);
        setStreamingText("");
        setStreamingRunId(null);
        setError(null);
        void Promise.all([fetchHistory(), fetchSessions()]);
        return;
      }

      if (state === "aborted") {
        setSending(false);
        setAwaitingFinal(false);
        setStreamingText("");
        setStreamingRunId(null);
        setError("Generation stopped.");
        void Promise.all([fetchHistory(), fetchSessions()]);
        return;
      }

      if (state === "error") {
        setSending(false);
        setAwaitingFinal(false);
        setStreamingText("");
        setStreamingRunId(null);
        setError(normalizeErrorMessage(payload.errorMessage));
        void Promise.all([fetchHistory(), fetchSessions()]);
      }
    },
    [fetchHistory, fetchSessions, sessionKey]
  );

  useGatewayEvents(handleGatewayEvent);

  // Agent working timer — counts up every second while waiting
  useEffect(() => {
    const isWorking = sending || (awaitingFinal && !streamingText);
    if (!isWorking) {
      setWorkingElapsed(0);
      return;
    }
    setWorkingElapsed(0);
    const interval = setInterval(() => {
      setWorkingElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [sending, awaitingFinal, streamingText]);

  const updateSessionModel = useCallback(
    async (nextModel: string | null) => {
      setActiveModel(nextModel);
      try {
        const res = await fetch("/api/chat/sessions", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionKey, model: nextModel }),
        });
        const data = (await res.json()) as {
          error?: string;
          warning?: string | null;
          appliedModel?: string | null;
          model?: string | null;
        };
        if (!res.ok) {
          setError(normalizeErrorMessage(data.error || `Request failed (${res.status})`));
          return;
        }
        const applied =
          data.appliedModel !== undefined ? data.appliedModel : data.model;
        if (applied !== undefined) {
          setActiveModel(applied ?? null);
        }
        if (data.warning) {
          setError(normalizeErrorMessage(data.warning));
        }
        void fetchSessions();
      } catch (err) {
        setError(normalizeErrorMessage(err));
      }
    },
    [fetchSessions, sessionKey]
  );

  const abortGeneration = useCallback(async () => {
    if (!sending && !awaitingFinal && !streamingRunId) return;

    setSending(false);
    setAwaitingFinal(false);

    try {
      await fetch("/api/chat", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionKey, runId: streamingRunId ?? undefined }),
      });
      setError("Generation stopped.");
    } catch {
      setError("Failed to stop generation.");
    } finally {
      setStreamingText("");
      setStreamingRunId(null);
      void Promise.all([fetchHistory(), fetchSessions()]);
    }
  }, [awaitingFinal, fetchHistory, fetchSessions, sending, sessionKey, streamingRunId]);

  const uploadAttachments = useCallback(
    async (attachments: FileAttachment[]): Promise<UploadedAttachment[]> => {
      if (attachments.length === 0) return [];
      const form = new FormData();
      for (const attachment of attachments) {
        form.append("files", attachment.file, attachment.name);
      }

      setUploadingAttachments(true);
      try {
        const res = await fetch("/api/chat/attachments", {
          method: "POST",
          body: form,
        });
        const data = (await res.json()) as AttachmentsApiResponse;
        if (!res.ok) {
          throw new Error(data.error || `Attachment upload failed (${res.status})`);
        }
        return Array.isArray(data.attachments) ? data.attachments : [];
      } finally {
        setUploadingAttachments(false);
      }
    },
    []
  );

  const runCouncil = useCallback(
    async (message: string): Promise<CouncilResult[]> => {
      const selectedModels = Array.from(new Set(councilModels.filter(Boolean))).slice(0, 4);
      if (selectedModels.length < 2) return [];

      const res = await fetch("/api/chat/council", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          sessionKey,
          models: selectedModels,
        }),
      });
      const data = (await res.json()) as CouncilApiResponse;
      if (!res.ok) {
        throw new Error(data.error || `Council request failed (${res.status})`);
      }
      return Array.isArray(data.results) ? data.results : [];
    },
    [councilModels, sessionKey]
  );

  const setCouncilModelAt = useCallback((index: number, value: string) => {
    setCouncilModels((prev) => {
      const next = [...prev];
      while (next.length < 3) next.push("");
      next[index] = value;
      return next;
    });
  }, []);

  const copySessionLink = useCallback(async () => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (sessionKey === DEFAULT_SESSION_KEY) {
      url.searchParams.delete("chatSession");
    } else {
      url.searchParams.set("chatSession", sessionKey);
    }
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopiedShare(true);
      setTimeout(() => setCopiedShare(false), 1500);
    } catch {
      setError("Unable to copy session link. Copy it from the address bar.");
    }
  }, [sessionKey]);

  const sendMessage = async () => {
    const text = input.trim();
    const attachments = attachmentsRef.current?.getAttachments() ?? [];
    const hasAttachments = attachments.length > 0;
    if ((!text && !hasAttachments) || sending || awaitingFinal || uploadingAttachments) return;

    const attachmentSummary = hasAttachments
      ? `Attached files: ${attachments.map((file) => file.name).join(", ")}`
      : "";
    const displayContent = [text, attachmentSummary].filter(Boolean).join("\n\n");

    const userMsg: ChatMessage = {
      role: "user",
      content: displayContent || "Sent attachments for analysis.",
      timestamp: new Date().toISOString(),
    };

    setInput("");
    // Reset auto-grown textarea height
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
    setSending(true);
    setAwaitingFinal(false);
    setStreamingText("");
    setStreamingRunId(null);
    setError(null);
    shouldAutoScrollRef.current = true;
    setMessages((prev) => [...prev, userMsg]);

    // Auto-generate session title from first user message
    if (conversationMessages.length === 0 && text) {
      const title = generateSessionTitle(text);
      setSessions((prev) =>
        prev.map((s) => (s.key === sessionKey ? { ...s, label: title } : s))
      );
      // Persist title to backend (fire-and-forget)
      void fetch("/api/chat/sessions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionKey, label: title }),
      }).catch(() => { });
    }

    let outboundMessage = text;

    if (hasAttachments) {
      try {
        const uploaded = await uploadAttachments(attachments);
        const attachmentContext = buildAttachmentContext(uploaded);
        const seed =
          text || "Analyze the attached files and provide a concise, structured response.";
        outboundMessage = attachmentContext
          ? `${seed}\n\n${attachmentContext}`
          : seed;
      } catch (err) {
        setSending(false);
        setAwaitingFinal(false);
        setError(normalizeErrorMessage(err));
        return;
      }
    }

    if (!outboundMessage.trim()) {
      setSending(false);
      setAwaitingFinal(false);
      return;
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: outboundMessage,
          sessionKey,
          model: activeModel ?? undefined,
        }),
      });

      const data = (await res.json()) as ChatApiResponse;
      if (!res.ok || data.error) {
        setSending(false);
        setAwaitingFinal(false);
        setError(normalizeErrorMessage(data.error || `Request failed (${res.status})`));
        return;
      }
      if (data.warning) {
        setError(normalizeErrorMessage(data.warning));
      }

      setComposerAttachments([]);
      attachmentsRef.current?.clear();

      if (councilEnabled) {
        setCouncilRunning(true);
        void runCouncil(outboundMessage)
          .then((results) => {
            if (results.length === 0) return;
            const councilMessage: ChatMessage = {
              role: "assistant",
              content: formatCouncilSummary(results),
              timestamp: new Date().toISOString(),
            };
            setMessages((prev) => [...prev, councilMessage]);
            // Do not auto-scroll when council responses arrive; user can click "Jump to latest".
          })
          .catch((err: unknown) => {
            setError(normalizeErrorMessage(err));
          })
          .finally(() => {
            setCouncilRunning(false);
          });
      }

      if (data.reply && typeof data.reply === "object") {
        setMessages((prev) => [...prev, data.reply as ChatMessage]);
        setSending(false);
        setAwaitingFinal(false);
        void fetchSessions();
        return;
      }

      setSending(false);
      setAwaitingFinal(true);
      setStreamingRunId(data.runId || null);
      if (data.fallbackModel) {
        setActiveModel(data.fallbackModel);
        setError(`Primary model unavailable. Switched to ${data.fallbackModel}.`);
      }
      void fetchSessions();
    } catch (err) {
      setSending(false);
      setAwaitingFinal(false);
      setError(normalizeErrorMessage(err));
    } finally {
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const selectSession = (key: string) => {
    if (key === sessionKey || sessionBusyKey) return;
    resetWindowRef.current = true;
    shouldAutoScrollRef.current = true;
    lastRenderCountRef.current = 0;
    setSessionKey(key);
    setMessages([]);
    setVisibleStartIndex(0);
    setStreamingText("");
    setStreamingRunId(null);
    setSending(false);
    setAwaitingFinal(false);
    setError(null);
    setHasUnseenUpdates(false);
    setIsAtBottom(false);
    setComposerAttachments([]);
    attachmentsRef.current?.clear();
  };

  const startNewSession = () => {
    const newKey = `${SESSION_PREFIX}mission-control:chat-${Date.now()}`;
    resetWindowRef.current = true;
    shouldAutoScrollRef.current = true;
    lastRenderCountRef.current = 0;
    setSessionKey(newKey);
    setMessages([]);
    setVisibleStartIndex(0);
    setStreamingText("");
    setStreamingRunId(null);
    setSending(false);
    setAwaitingFinal(false);
    setError(null);
    setHasUnseenUpdates(false);
    setIsAtBottom(true);
    setActiveModel(null);
    setComposerAttachments([]);
    attachmentsRef.current?.clear();
  };

  const deleteSession = async (key: string) => {
    if (sessionBusyKey || key === DEFAULT_SESSION_KEY) return;

    try {
      setSessionBusyKey(key);
      const res = await fetch("/api/chat/sessions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionKey: key }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(normalizeErrorMessage(data.error || `Request failed (${res.status})`));
        return;
      }

      setSessions((prev) => prev.filter((session) => session.key !== key));
      if (sessionKey === key) {
        startNewSession();
      }
    } catch (err) {
      setError(normalizeErrorMessage(err));
    } finally {
      setSessionBusyKey(null);
    }
  };

  const loadOlderMessages = useCallback(() => {
    const el = scrollContainerRef.current;
    if (el) {
      shouldAutoScrollRef.current = false;
      prependScrollAnchorRef.current = {
        top: el.scrollTop,
        height: el.scrollHeight,
      };
    }
    setVisibleStartIndex((prev) => Math.max(0, prev - MESSAGE_RENDER_STEP));
  }, []);

  const hasReadyAttachments = composerAttachments.some(
    (attachment) => attachment.status === "ready"
  );
  const hasPendingAttachments = composerAttachments.some(
    (attachment) => attachment.status === "pending" || attachment.status === "processing"
  );
  const canSendMessage =
    (Boolean(input.trim()) || hasReadyAttachments) &&
    !sending &&
    !awaitingFinal &&
    !uploadingAttachments &&
    !hasPendingAttachments;

  const showAgentWorkingIndicator = sending || (awaitingFinal && !streamingText);

  const copyMessageText = useCallback(async (text: string, index: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageIndex(index);
      setTimeout(() => setCopiedMessageIndex(null), 1500);
    } catch {
      // Clipboard not available
    }
  }, []);

  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchError(null);
    setSearchResults([]);
    setSearchSessions([]);
  }, []);

  const startEditTags = useCallback(() => {
    setTagsDraft(sessionTags.join(", "));
    setTagsEditing(true);
  }, [sessionTags]);

  const cancelEditTags = useCallback(() => {
    setTagsEditing(false);
    setTagsDraft("");
  }, []);

  const saveTags = useCallback(async () => {
    const tags = parseTagsInput(tagsDraft);
    setTagsLoading(true);
    try {
      const res = await fetch("/api/chat/tags", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionKey, tags }),
      });
      const data = (await res.json()) as TagsApiResponse;
      if (!res.ok) {
        setError(normalizeErrorMessage(data.error || `Request failed (${res.status})`));
        return;
      }
      setSessionTags(Array.isArray(data.tags) ? data.tags : tags);
      setTagsEditing(false);
      setTagsDraft("");
    } catch (err) {
      setError(normalizeErrorMessage(err));
    } finally {
      setTagsLoading(false);
    }
  }, [sessionKey, tagsDraft]);

  const retryFromMessage = useCallback(
    (messageIndex: number) => {
      // Find the user message immediately before this assistant message
      const absIndex = visibleStartIndex + messageIndex;
      const allConversation = conversationMessages;
      if (absIndex <= 0 || absIndex >= allConversation.length) return;
      const previousUserMsg = allConversation[absIndex - 1];
      if (previousUserMsg?.role !== "user") return;
      const text = extractText(previousUserMsg.content);
      if (!text) return;
      setInput(text);
      inputRef.current?.focus();
    },
    [conversationMessages, visibleStartIndex]
  );

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      <aside className="hidden lg:flex w-72 shrink-0 border-r border-border/70 bg-background/30 backdrop-blur-sm flex-col">
        <div className="px-3 py-3 border-b border-border/70 flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Sessions
          </div>
          <button
            onClick={startNewSession}
            className="p-1.5 rounded-md border border-border text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors"
            title="New session"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        <div className="px-3 py-3 border-b border-border/70 space-y-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search history..."
              className="w-full bg-background/60 border border-border rounded-md pl-8 pr-8 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40"
            />
            {searchActive && (
              <button
                onClick={clearSearch}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                title="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <button
              onClick={() => setSearchFiltersOpen((prev) => !prev)}
              className="inline-flex items-center gap-1 hover:text-foreground"
              title="Search filters"
            >
              <SlidersHorizontal className="w-3 h-3" />
              Filters
            </button>
            {searchActive && (
              <div className="inline-flex rounded-md border border-border bg-background/40 overflow-hidden">
                <button
                  onClick={() => setSearchView("messages")}
                  className={`px-2 py-0.5 text-[10px] ${searchView === "messages"
                    ? "bg-primary/20 text-primary"
                    : "text-muted-foreground hover:text-foreground"
                    }`}
                >
                  Messages
                </button>
                <button
                  onClick={() => setSearchView("sessions")}
                  className={`px-2 py-0.5 text-[10px] ${searchView === "sessions"
                    ? "bg-primary/20 text-primary"
                    : "text-muted-foreground hover:text-foreground"
                    }`}
                >
                  Sessions
                </button>
              </div>
            )}
          </div>

          {searchFiltersOpen && (
            <div className="space-y-2 text-xs text-muted-foreground">
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wide">Channel</label>
                <input
                  value={searchChannel}
                  onChange={(e) => setSearchChannel(e.target.value)}
                  placeholder="telegram, slack, webchat..."
                  className="w-full bg-background/60 border border-border rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wide">Tags</label>
                <input
                  value={searchTagsDraft}
                  onChange={(e) => setSearchTagsDraft(e.target.value)}
                  placeholder="deploy, bugs, roadmap"
                  className="w-full bg-background/60 border border-border rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wide">Range</label>
                <select
                  value={searchRange}
                  onChange={(e) => setSearchRange(e.target.value as "24h" | "7d" | "30d" | "all")}
                  className="w-full bg-background/60 border border-border rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40"
                >
                  <option value="24h">Last 24 hours</option>
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                  <option value="all">All time</option>
                </select>
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1">
          {!searchActive && sessionsLoading && (
            <div className="text-xs text-muted-foreground px-2 py-2 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Loading sessions...
            </div>
          )}

          {searchActive && searchLoading && (
            <div className="text-xs text-muted-foreground px-2 py-2 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Searching...
            </div>
          )}

          {searchActive && searchError && (
            <div className="text-xs text-destructive px-2 py-2">
              {searchError}
            </div>
          )}

          {!searchActive && !sessionsLoading && displayedSessions.length === 0 && (
            <div className="text-xs text-muted-foreground px-2 py-2">
              No prior sessions yet.
            </div>
          )}

          {searchActive && !searchLoading && !searchError && searchView === "messages" && searchResults.length === 0 && (
            <div className="text-xs text-muted-foreground px-2 py-2">
              No matching messages.
            </div>
          )}

          {searchActive && !searchLoading && !searchError && searchView === "sessions" && searchSessions.length === 0 && (
            <div className="text-xs text-muted-foreground px-2 py-2">
              No matching sessions.
            </div>
          )}

          {searchActive && searchView === "messages" && searchResults.map((result) => {
            const title = result.sessionTitle || compactSessionLabel(result.sessionKey);
            const preview = truncateText(cleanText(result.content), 160);
            return (
              <button
                key={result.id}
                onClick={() => selectSession(result.sessionKey)}
                className="w-full text-left rounded-lg border border-transparent hover:border-border/60 hover:bg-card/60 px-3 py-2 transition-all"
              >
                <div className="text-xs font-semibold text-foreground truncate">{title}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">{preview}</div>
                <div className="mt-1 text-[10px] text-muted-foreground flex items-center gap-2">
                  <span>{result.role}</span>
                  <span>{formatRelativeFromTimestamp(result.createdAt)}</span>
                  {result.channel && <span className="truncate">{result.channel}</span>}
                </div>
              </button>
            );
          })}

          {searchActive && searchView === "sessions" && searchSessions.map((session) => {
            const updated =
              typeof session.lastMessageAt === "number"
                ? session.lastMessageAt
                : session.updatedAt ?? null;
            return (
              <button
                key={session.sessionKey}
                onClick={() => selectSession(session.sessionKey)}
                className="w-full text-left rounded-lg border border-transparent hover:border-border/60 hover:bg-card/60 px-3 py-2 transition-all"
              >
                <div className="text-xs font-semibold text-foreground truncate">
                  {session.title || compactSessionLabel(session.sessionKey)}
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground flex items-center gap-2">
                  <span>{session.matches} match{session.matches === 1 ? "" : "es"}</span>
                  <span>{formatRelativeFromTimestamp(updated ?? undefined)}</span>
                  {session.channel && <span className="truncate">{session.channel}</span>}
                </div>
              </button>
            );
          })}

          {!searchActive && displayedSessions.map((session) => {
            const active = session.key === sessionKey;
            const busy = sessionBusyKey === session.key;
            const modelRef = session.model || null;

            return (
              <div
                key={session.key}
                className={`group rounded-lg border transition-all duration-200 ${active
                  ? "border-primary/40 bg-primary/10 chat-session-active"
                  : "border-transparent hover:border-border/60 hover:bg-card/60"
                  }`}
              >
                <button
                  onClick={() => selectSession(session.key)}
                  className="w-full text-left px-3 py-2.5"
                >
                  <div className={`text-xs font-medium truncate ${active ? "text-primary" : "text-foreground"}`}>
                    {session.label || compactSessionLabel(session.key)}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Clock3 className="w-3 h-3" />
                      {formatRelativeTime(session.lastActivity)}
                    </span>
                    {typeof session.totalTokens === "number" && session.totalTokens > 0 && (
                      <span>{session.totalTokens.toLocaleString()} tok</span>
                    )}
                    {modelRef && (
                      <span className="truncate max-w-[120px]">{modelRef}</span>
                    )}
                  </div>
                </button>

                <div className="px-3 pb-2 flex justify-end">
                  <button
                    onClick={() => void deleteSession(session.key)}
                    disabled={busy || session.key === DEFAULT_SESSION_KEY}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground hover:text-destructive disabled:opacity-20 transition-opacity"
                    title="Delete session"
                  >
                    {busy ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Trash2 className="w-3 h-3" />
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      <div className="relative flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/70 gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center shrink-0">
              <Bot className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight truncate">Agent Chat</h2>
              <p className="text-xs text-muted-foreground truncate">
                {activeSession?.label || compactSessionLabel(sessionKey)}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {tagsLoading ? (
                  <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Loading tags...
                  </span>
                ) : (
                  sessionTags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary"
                    >
                      <Tag className="w-3 h-3" />
                      {tag}
                    </span>
                  ))
                )}
                <button
                  onClick={tagsEditing ? cancelEditTags : startEditTags}
                  className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                >
                  <Tag className="w-3 h-3" />
                  {sessionTags.length > 0 ? (tagsEditing ? "Cancel" : "Edit tags") : "Add tags"}
                </button>
              </div>
              {tagsEditing && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    value={tagsDraft}
                    onChange={(event) => setTagsDraft(event.target.value)}
                    placeholder="comma, separated, tags"
                    className="h-8 w-64 max-w-full rounded border border-border bg-card px-2 text-xs text-foreground"
                  />
                  <button
                    onClick={() => void saveTags()}
                    className="h-8 rounded border border-border px-2 text-xs text-foreground hover:border-primary/40 hover:text-primary"
                  >
                    Save
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <select
              value={activeModel || ""}
              onChange={(event) =>
                void updateSessionModel(event.target.value ? event.target.value : null)
              }
              disabled={modelsLoading || sortedModels.length === 0}
              className="h-8 max-w-[280px] rounded border border-border bg-card px-2 text-xs text-foreground"
              title="Session model override"
            >
              <option value="">Auto model</option>
              {(() => {
                const tierLabels: Record<string, string> = {
                  popular: "Popular",
                  fast: "Fast & Efficient",
                  reasoning: "Reasoning",
                  coding: "Coding",
                  budget: "Budget & Open Source",
                };
                const groups: Record<string, ModelOption[]> = {};
                const uncataloged: ModelOption[] = [];
                for (const model of sortedModels) {
                  if (model.tier && tierLabels[model.tier]) {
                    (groups[model.tier] ??= []).push(model);
                  } else {
                    uncataloged.push(model);
                  }
                }
                const tierOrder = ["popular", "fast", "reasoning", "coding", "budget"];
                return (
                  <>
                    {tierOrder.map((tier) =>
                      groups[tier]?.length ? (
                        <optgroup key={tier} label={tierLabels[tier]}>
                          {groups[tier].map((model) => (
                            <option key={model.id} value={model.id}>
                              {toModelLabel(model)}
                            </option>
                          ))}
                        </optgroup>
                      ) : null
                    )}
                    {uncataloged.length > 0 && (
                      <optgroup label="Other">
                        {uncataloged.map((model) => (
                          <option key={model.id} value={model.id}>
                            {toModelLabel(model)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </>
                );
              })()}
            </select>

            <button
              onClick={() => void Promise.all([fetchHistory(), fetchSessions()])}
              className="p-2 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/5 transition-all"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>

            <button
              onClick={() => void abortGeneration()}
              disabled={!sending && !awaitingFinal && !streamingRunId}
              className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-30 disabled:hover:text-muted-foreground transition-all"
              title="Stop generation"
            >
              <Square className="w-4 h-4" />
            </button>

            <button
              onClick={() => void copySessionLink()}
              className="p-2 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/5 transition-all"
              title={copiedShare ? "Session link copied" : "Copy session link"}
            >
              <Copy className="w-4 h-4" />
            </button>

            <button
              onClick={startNewSession}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-muted-foreground hover:text-primary hover:bg-primary/5 border border-border transition-all"
            >
              <Plus className="w-4 h-4" />
              New
            </button>
          </div>
        </div>

        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          data-testid="mc-chat-scroll-root"
          className="flex-1 min-h-0 overflow-y-auto px-6 py-4"
        >
          {loading && messages.length === 0 && (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              Loading conversation...
            </div>
          )}

          {!loading && conversationMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center min-h-full py-12 text-center">
              <div className="w-20 h-20 rounded-2xl chat-gradient-icon flex items-center justify-center mb-5">
                <Sparkles className="w-9 h-9 text-primary" />
              </div>
              <h3 className="text-xl font-semibold text-foreground mb-1.5 tracking-tight">
                Start a conversation
              </h3>
              <p className="text-sm text-muted-foreground max-w-md mb-8 leading-relaxed">
                Ask questions, dispatch work, or request multi-step actions.
                <br />
                <span className="text-muted-foreground/70">Session history is preserved in the sidebar.</span>
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-xl w-full">
                {[
                  { emoji: "📊", prompt: "Summarize today's agent activity" },
                  { emoji: "⏳", prompt: "What tasks are currently in progress?" },
                  { emoji: "🔍", prompt: "Run a health check on all integrations" },
                  { emoji: "⚠️", prompt: "Show me recent errors or failures" },
                ].map(({ emoji, prompt }) => (
                  <button
                    key={prompt}
                    onClick={() => {
                      setInput(prompt);
                      inputRef.current?.focus();
                    }}
                    className="chat-suggestion-card scale-in text-left text-sm px-4 py-3 rounded-xl border border-border/60 bg-card/60 backdrop-blur-sm text-muted-foreground hover:text-foreground transition-all flex items-start gap-2.5"
                  >
                    <span className="text-base mt-0.5 shrink-0">{emoji}</span>
                    <span className="leading-relaxed">{prompt}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="max-w-3xl mx-auto w-full space-y-4">

            {hiddenMessageCount > 0 && (
              <div className="sticky top-0 z-10 flex justify-center pb-2">
                <button
                  onClick={loadOlderMessages}
                  className="rounded-full border border-border bg-card/95 px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur hover:border-primary/30 hover:text-primary transition-colors"
                >
                  Load {Math.min(MESSAGE_RENDER_STEP, hiddenMessageCount)} older messages
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    ({hiddenMessageCount} hidden)
                  </span>
                </button>
              </div>
            )}

            {renderedMessages.map((msg, i) => {
              const isUser = msg.role === "user";
              const text = extractText(msg.content);
              const time = formatMessageTime(msg.timestamp);
              const key = `msg-${visibleStartIndex + i}-${msg.runId || ""}-${String(
                msg.timestamp || ""
              )}`;
              const isCopied = copiedMessageIndex === i;

              return (
                <div
                  key={key}
                  className={`chat-message-enter group/msg flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}
                >
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isUser
                      ? "bg-primary/20 text-primary"
                      : "bg-emerald-500/10 text-emerald-400"
                      }`}
                  >
                    {isUser ? (
                      <User className="w-4 h-4" />
                    ) : (
                      <Bot className="w-4 h-4" />
                    )}
                  </div>

                  <div className="max-w-[80%] flex flex-col">
                    <div
                      className={`rounded-2xl px-4 py-3 ${isUser
                        ? "bg-primary text-primary-foreground rounded-tr-md"
                        : "bg-card border border-border rounded-tl-md"
                        }`}
                    >
                      {text ? (
                        isUser ? (
                          <div className="text-sm whitespace-pre-wrap break-words leading-relaxed">
                            {text}
                          </div>
                        ) : (
                          <ChatMarkdown content={text} />
                        )
                      ) : (
                        <div className="text-sm whitespace-pre-wrap break-words leading-relaxed">
                          <span className="text-muted-foreground italic">
                            {msg.errorMessage
                              ? normalizeErrorMessage(msg.errorMessage)
                              : msg.stopReason === "toolUse"
                                ? "Agent is using tools..."
                                : "(no content)"}
                          </span>
                        </div>
                      )}
                      {time && (
                        <div
                          className={`text-[10px] mt-1 ${isUser
                            ? "text-primary-foreground/60"
                            : "text-muted-foreground"
                            }`}
                        >
                          {time}
                        </div>
                      )}
                    </div>

                    {/* Message actions — visible on hover */}
                    <div
                      className={`flex gap-1 mt-1 opacity-0 group-hover/msg:opacity-100 transition-opacity ${isUser ? "justify-end" : "justify-start"
                        }`}
                    >
                      {text && (
                        <button
                          onClick={() => void copyMessageText(text, i)}
                          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                          title="Copy message"
                        >
                          {isCopied ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                      {!isUser && (
                        <button
                          onClick={() => retryFromMessage(i)}
                          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                          title="Retry — load previous prompt into composer"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {streamingText && (
              <div className="chat-message-enter flex gap-3">
                <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
                  <Bot className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="max-w-[80%] bg-card border border-border rounded-2xl rounded-tl-md px-4 py-3">
                  <ChatMarkdown content={streamingText} />
                  {streamingRunId && (
                    <div className="text-[10px] mt-1 text-muted-foreground">
                      run {streamingRunId.slice(0, 8)}
                    </div>
                  )}
                </div>
              </div>
            )}

            {showAgentWorkingIndicator && (
              <div className="chat-message-enter flex gap-3">
                <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
                  <Bot className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="bg-card border border-border rounded-2xl rounded-tl-md px-4 py-3">
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <span className="thinking-dot" />
                      <span className="thinking-dot" />
                      <span className="thinking-dot" />
                    </div>
                    <span className="font-medium">
                      {awaitingFinal && !sending
                        ? "Agent is using tools"
                        : "Thinking"}
                    </span>
                    <span className={`text-[11px] tabular-nums ${workingElapsed > 0 && workingElapsed % 30 < 2 ? "text-primary font-medium" : ""}`}>
                      {formatElapsedTime(workingElapsed)}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="mx-auto max-w-xl text-center text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-2">
                {error}
              </div>
            )}
          </div>
        </div>

        {hasUnseenUpdates && !isAtBottom && (
          <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-20">
            <button
              onClick={() => scrollToBottom("smooth")}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-xs font-medium text-foreground shadow-sm hover:border-primary/40 hover:text-primary transition-colors"
            >
              <ArrowDown className="w-3.5 h-3.5" />
              Jump to latest
            </button>
          </div>
        )}

        <div
          data-testid="mc-chat-composer"
          className="px-6 py-4 border-t border-border/70 bg-background/70 backdrop-blur-sm"
        >
          <div className="max-w-3xl mx-auto w-full">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <FileAttachments
                ref={attachmentsRef}
                onAttachmentsChange={setComposerAttachments}
                disabled={sending || awaitingFinal || uploadingAttachments}
                showFileBrowser={false}
                className="flex-1"
              />

              <div className="flex items-center gap-2">
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Council
                </label>
                <button
                  onClick={() => setCouncilEnabled((prev) => !prev)}
                  className={`h-6 w-11 rounded-full transition-colors ${councilEnabled ? "bg-primary/70" : "bg-muted"
                    }`}
                  title="Toggle council mode"
                >
                  <span
                    className={`block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${councilEnabled ? "translate-x-5" : "translate-x-0.5"
                      }`}
                  />
                </button>
              </div>
            </div>

            {councilEnabled && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {[0, 1, 2].map((index) => (
                  <select
                    key={index}
                    value={councilModels[index] ?? ""}
                    onChange={(event) => setCouncilModelAt(index, event.target.value)}
                    className="h-8 min-w-[190px] rounded border border-border bg-card px-2 text-xs text-foreground"
                  >
                    <option value="">Select model</option>
                    {sortedModels.map((model) => (
                      <option key={`${index}-${model.id}`} value={model.id}>
                        {toModelLabel(model)}
                      </option>
                    ))}
                  </select>
                ))}
              </div>
            )}

            <div className="chat-composer-ring flex items-end gap-2 bg-card border border-border rounded-2xl px-4 py-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
                  setInput(e.target.value);
                  /* Auto-grow textarea */
                  const el = e.target;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                }}
                onKeyDown={handleKeyDown}
                placeholder="Type a message..."
                rows={1}
                disabled={sending || awaitingFinal}
                maxLength={5000}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none py-1.5 disabled:opacity-50 transition-[height] duration-100"
                style={{ minHeight: "24px", maxHeight: "160px" }}
              />
              <button
                onClick={() => void sendMessage()}
                disabled={!canSendMessage}
                type="button"
                aria-label="Send message"
                className="p-2.5 rounded-xl bg-primary text-primary-foreground disabled:opacity-30 hover:bg-primary/90 hover:shadow-md transition-all shrink-0"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1.5 text-center">
              {uploadingAttachments
                ? "Uploading attachments..."
                : councilRunning
                  ? "Council mode is gathering parallel model responses..."
                  : copiedShare
                    ? "Session link copied to clipboard."
                    : "Press Enter to send · Shift+Enter for new line"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
