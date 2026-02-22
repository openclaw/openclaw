"use client";

import * as React from "react";
import { useState, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Globe,
  Loader2,
  Search,
} from "lucide-react";

// ============================================================================
// Types
// ============================================================================

export interface WebSource {
  id: number;
  title: string;
  url: string;
  snippet: string;
  favicon: string;
  domain: string;
}

export interface SearchState {
  isSearching: boolean;
  queries: string[];
  currentQuery?: string;
  sources: WebSource[];
  error?: string;
}

interface WebSourcesProps {
  sources: WebSource[];
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  maxVisible?: number;
  className?: string;
}

interface SearchProgressProps {
  state: SearchState;
  className?: string;
}

interface CitationLinkProps {
  index: number;
  source: WebSource;
  onHover?: (source: WebSource | null) => void;
  onClick?: (source: WebSource) => void;
}

interface SourcePreviewTooltipProps {
  source: WebSource;
  children: React.ReactNode;
}

// ============================================================================
// Source Card Component
// ============================================================================

function SourceCard({
  source,
  index,
  compact = false,
}: {
  source: WebSource;
  index: number;
  compact?: boolean;
}) {
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "group flex gap-3 rounded-lg border bg-card p-3 transition-all",
        "hover:border-primary/50 hover:bg-accent/50 hover:shadow-md",
        compact ? "p-2" : "p-3"
      )}
    >
      {/* Favicon & Index */}
      <div className="flex flex-col items-center gap-1">
        <div className="relative flex h-8 w-8 items-center justify-center rounded-md bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={source.favicon}
            alt=""
            className="h-5 w-5 rounded-sm"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
              (e.target as HTMLImageElement).nextElementSibling?.classList.remove("hidden");
            }}
          />
          <Globe className="hidden h-4 w-4 text-muted-foreground" />
        </div>
        <span className="text-[10px] font-medium text-muted-foreground">
          [{index}]
        </span>
      </div>

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <span className="text-xs font-medium text-primary truncate">
            {source.domain}
          </span>
          <ExternalLink className="h-3 w-3 flex-shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
        <h4 className="line-clamp-2 text-sm font-medium leading-tight">
          {source.title}
        </h4>
        {!compact && source.snippet && (
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {source.snippet}
          </p>
        )}
      </div>
    </a>
  );
}

// ============================================================================
// Compact Source Pill (for collapsed view)
// ============================================================================

function SourcePill({ source }: { source: WebSource }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1",
              "transition-all hover:border-primary/50 hover:bg-accent/50"
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={source.favicon}
              alt=""
              className="h-4 w-4 rounded-sm"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
            <span className="max-w-[100px] truncate text-xs text-muted-foreground">
              {source.domain}
            </span>
          </a>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-1">
            <p className="font-medium">{source.title}</p>
            <p className="text-xs text-muted-foreground line-clamp-2">
              {source.snippet}
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ============================================================================
// Web Sources Panel (Perplexity-style)
// ============================================================================

export function WebSourcesPanel({
  sources,
  isExpanded: controlledExpanded,
  onToggleExpand,
  maxVisible = 3,
  className,
}: WebSourcesProps) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const isExpanded = controlledExpanded ?? internalExpanded;
  const toggleExpand = onToggleExpand ?? (() => setInternalExpanded((v) => !v));

  const panelRef = useRef<HTMLDivElement>(null);

  if (sources.length === 0) {return null;}

  const visibleSources = isExpanded ? sources : sources.slice(0, maxVisible);
  const hasMore = sources.length > maxVisible;

  return (
    <div
      ref={panelRef}
      id="web-sources-panel"
      className={cn(
        "rounded-xl border bg-muted/30 p-4 transition-all",
        className
      )}
    >
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10">
            <Search className="h-3.5 w-3.5 text-primary" />
          </div>
          <h3 className="text-sm font-semibold">
            Sources
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              ({sources.length})
            </span>
          </h3>
        </div>
        {hasMore && (
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleExpand}
            className="h-7 gap-1 text-xs"
          >
            {isExpanded ? (
              <>
                Show less
                <ChevronUp className="h-3 w-3" />
              </>
            ) : (
              <>
                View all {sources.length}
                <ChevronDown className="h-3 w-3" />
              </>
            )}
          </Button>
        )}
      </div>

      {/* Collapsed view - horizontal pills */}
      {!isExpanded && (
        <div className="flex flex-wrap gap-2">
          {visibleSources.map((source) => (
            <SourcePill key={source.id} source={source} />
          ))}
          {hasMore && (
            <button
              onClick={toggleExpand}
              className="inline-flex items-center gap-1 rounded-full border border-dashed bg-card/50 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              +{sources.length - maxVisible} more
            </button>
          )}
        </div>
      )}

      {/* Expanded view - full cards */}
      {isExpanded && (
        <div className="grid gap-2 sm:grid-cols-2">
          {visibleSources.map((source, idx) => (
            <SourceCard key={source.id} source={source} index={idx + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Search Progress Indicator
// ============================================================================

export function SearchProgress({ state, className }: SearchProgressProps) {
  if (!state.isSearching && state.sources.length === 0 && !state.error) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-muted/30 p-3",
        className
      )}
    >
      {state.isSearching ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Searching the web...</span>
            {state.currentQuery && (
              <span className="text-xs text-muted-foreground">
                &quot;{state.currentQuery}&quot;
              </span>
            )}
          </div>
        </>
      ) : state.error ? (
        <>
          <div className="h-4 w-4 rounded-full bg-destructive/20 text-destructive">
            <span className="flex h-full w-full items-center justify-center text-xs">
              !
            </span>
          </div>
          <span className="text-sm text-destructive">{state.error}</span>
        </>
      ) : (
        <>
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/20">
            <Search className="h-3 w-3 text-emerald-600" />
          </div>
          <span className="text-sm text-muted-foreground">
            Found {state.sources.length} source{state.sources.length !== 1 ? "s" : ""}
          </span>
        </>
      )}
    </div>
  );
}

// ============================================================================
// Citation Link (inline [1] style)
// ============================================================================

export function CitationLink({
  index,
  source,
  onHover,
  onClick,
}: CitationLinkProps) {
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (onClick) {
      onClick(source);
    } else {
      // Default: scroll to sources panel
      const panel = document.getElementById("web-sources-panel");
      if (panel) {
        panel.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  };

  return (
    <SourcePreviewTooltip source={source}>
      <button
        onClick={handleClick}
        onMouseEnter={() => onHover?.(source)}
        onMouseLeave={() => onHover?.(null)}
        className={cn(
          "inline-flex items-center justify-center",
          "ml-0.5 h-4 min-w-4 rounded px-1 align-super text-[10px] font-semibold",
          "bg-primary/10 text-primary transition-colors",
          "hover:bg-primary/20 focus:outline-none focus:ring-2 focus:ring-primary/50"
        )}
      >
        {index}
      </button>
    </SourcePreviewTooltip>
  );
}

// ============================================================================
// Source Preview Tooltip
// ============================================================================

function SourcePreviewTooltip({ source, children }: SourcePreviewTooltipProps) {
  return (
    <TooltipProvider>
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          side="top"
          className="w-72 p-0"
          sideOffset={8}
        >
          <div className="flex gap-3 p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={source.favicon}
              alt=""
              className="h-6 w-6 flex-shrink-0 rounded"
            />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-xs font-medium text-primary">{source.domain}</p>
              <p className="line-clamp-2 text-sm font-medium">{source.title}</p>
              {source.snippet && (
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  {source.snippet}
                </p>
              )}
            </div>
          </div>
          <div className="border-t bg-muted/50 px-3 py-1.5">
            <span className="text-[10px] text-muted-foreground">
              Click to view source
            </span>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ============================================================================
// Parse citations in text (e.g., [1], [2])
// ============================================================================

export function parseCitations(
  text: string,
  sources: WebSource[]
): React.ReactNode[] {
  const citationRegex = /\[(\d+)\]/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = citationRegex.exec(text)) !== null) {
    // Add text before citation
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    // Add citation link
    const citationNum = parseInt(match[1], 10);
    const source = sources[citationNum - 1];

    if (source) {
      parts.push(
        <CitationLink key={`cite-${match.index}`} index={citationNum} source={source} />
      );
    } else {
      // Keep original text if source not found
      parts.push(match[0]);
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

// ============================================================================
// Hook: useWebSearch
// ============================================================================

interface UseWebSearchOptions {
  onSourcesFound?: (sources: WebSource[]) => void;
  count?: number;
}

export function useWebSearch(options: UseWebSearchOptions = {}) {
  const { onSourcesFound, count = 5 } = options;
  const [state, setState] = useState<SearchState>({
    isSearching: false,
    queries: [],
    sources: [],
  });

  const search = useCallback(
    async (query: string): Promise<WebSource[]> => {
      setState((prev) => ({
        ...prev,
        isSearching: true,
        currentQuery: query,
        queries: [...prev.queries, query],
        error: undefined,
      }));

      try {
        const response = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, count }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Search failed");
        }

        const data = await response.json();
        const sources: WebSource[] = data.results.map(
          (
            result: {
              title: string;
              url: string;
              snippet: string;
              favicon: string;
              domain: string;
            },
            idx: number
          ) => ({
            id: Date.now() + idx,
            ...result,
          })
        );

        setState((prev) => ({
          ...prev,
          isSearching: false,
          currentQuery: undefined,
          sources: [...prev.sources, ...sources],
        }));

        onSourcesFound?.(sources);
        return sources;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Search failed";
        setState((prev) => ({
          ...prev,
          isSearching: false,
          currentQuery: undefined,
          error: errorMessage,
        }));
        return [];
      }
    },
    [count, onSourcesFound]
  );

  const reset = useCallback(() => {
    setState({
      isSearching: false,
      queries: [],
      sources: [],
    });
  }, []);

  return {
    ...state,
    search,
    reset,
  };
}

// ============================================================================
// Hook: useSearchEnabledChat
// Integrates web search with chat functionality
// ============================================================================

interface UseSearchEnabledChatOptions {
  enabled?: boolean;
  maxSources?: number;
}

export function useSearchEnabledChat(options: UseSearchEnabledChatOptions = {}) {
  const { enabled = true, maxSources = 5 } = options;
  const webSearch = useWebSearch({ count: maxSources });
  const [pendingSources, setPendingSources] = useState<WebSource[]>([]);

  /**
   * Prepare context with web search results
   * Returns the enhanced prompt and sources to attach to the message
   */
  const prepareSearchContext = useCallback(
    async (userMessage: string): Promise<{
      enhancedPrompt: string;
      sources: WebSource[];
    }> => {
      if (!enabled) {
        return { enhancedPrompt: userMessage, sources: [] };
      }

      // Search the web
      const sources = await webSearch.search(userMessage);

      if (sources.length === 0) {
        return { enhancedPrompt: userMessage, sources: [] };
      }

      // Build context with sources
      const sourcesContext = sources
        .map(
          (source, idx) =>
            `[${idx + 1}] ${source.title}\nURL: ${source.url}\n${source.snippet}`
        )
        .join("\n\n");

      const enhancedPrompt = `Based on the following web search results, answer the user's question. Cite sources using [1], [2], etc.

Web Search Results:
${sourcesContext}

User Question: ${userMessage}

Please provide a comprehensive answer, citing the sources where appropriate using [1], [2], etc. format.`;

      setPendingSources(sources);
      return { enhancedPrompt, sources };
    },
    [enabled, webSearch]
  );

  /**
   * Get sources for the current pending response
   */
  const consumePendingSources = useCallback(() => {
    const sources = pendingSources;
    setPendingSources([]);
    return sources;
  }, [pendingSources]);

  return {
    searchState: webSearch,
    prepareSearchContext,
    consumePendingSources,
    isSearchEnabled: enabled,
    pendingSources,
  };
}

// ============================================================================
// Message with Citations Component
// ============================================================================

interface MessageWithCitationsProps {
  content: string;
  sources: WebSource[];
  className?: string;
}

export function MessageWithCitations({
  content,
  sources,
  className,
}: MessageWithCitationsProps) {
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Parse content and replace citations
  const parsedContent = React.useMemo(
    () => parseCitations(content, sources),
    [content, sources]
  );

  return (
    <div className={cn("space-y-4", className)}>
      {/* Message content with inline citations */}
      <div ref={contentRef} className="prose prose-sm dark:prose-invert max-w-none">
        {parsedContent}
      </div>

      {/* Sources panel */}
      {sources.length > 0 && (
        <WebSourcesPanel
          sources={sources}
          isExpanded={sourcesExpanded}
          onToggleExpand={() => setSourcesExpanded((v) => !v)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Exports
// ============================================================================

export type { WebSourcesProps, SearchProgressProps };
