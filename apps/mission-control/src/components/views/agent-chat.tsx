"use client";

import {
  createElement,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import * as LucideIcons from "lucide-react";
import { DEFAULT_WORKSPACE } from "@/lib/workspaces";
import {
  MessageSquare,
  Search,
  Star,
  StarOff,
  Clock,
  ChevronDown,
  ChevronUp,
  Send,
  Loader2,
  Copy,
  Check,
  Download,
  ClipboardList,
  Users,
  Bot,
  Eye,
  EyeOff,
  Sparkles,
  RefreshCw,
  X,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  SPECIALIZED_AGENTS,
  type SpecializedAgent,
  getAgentSuggestedTasks,
} from "@/lib/agent-registry";

// ========== Types ==========

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  agentId?: string;
  agentName?: string;
}

interface AgentChatState {
  messages: ChatMessage[];
  isTyping: boolean;
  sessionKey: string;
}

interface ChatApiResponse {
  error?: string;
  reply?: { content?: string } | string | null;
  queued?: boolean;
  priorAssistantCount?: number;
  pollAfterMs?: number;
  messages?: Array<{ role: string; content: string }>;
}

// Local storage keys
const FAVORITES_KEY = "agent-chat-favorites";
const RECENT_KEY = "agent-chat-recent";

// ========== Helper Functions ==========

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function formatTimestamp(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(date: Date): string {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return "Today";
  } else if (date.toDateString() === yesterday.toDateString()) {
    return "Yesterday";
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

// Dynamic icon renderer
function getIconComponent(iconName: string): LucideIcon {
  const icons = LucideIcons as unknown as Record<string, LucideIcon>;
  const Icon = icons[iconName];
  return Icon || LucideIcons.Bot;
}

function AgentIcon({
  iconName,
  className = "w-5 h-5"
}: {
  iconName: string;
  className?: string;
}) {
  return createElement(getIconComponent(iconName), { className });
}

function getSuggestedPrompts(agent: SpecializedAgent): string[] {
  // Use agent's built-in suggested tasks, or generate generic ones
  const tasks = getAgentSuggestedTasks(agent.id);
  if (tasks && tasks.length > 0) {
    return tasks.slice(0, 4);
  }
  return [
    `Tell me about your expertise as ${agent.name}`,
    `What are your key capabilities?`,
    "How can you help with my current project?",
    `Walk me through a typical ${agent.name.toLowerCase()} workflow`,
  ];
}

// ========== Main Component ==========

export function AgentChat() {
  // Agent selection state
  const [selectedAgent, setSelectedAgent] = useState<SpecializedAgent | null>(
    null
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>(() => {
    if (typeof window === "undefined") {return [];}
    try {
      const stored = localStorage.getItem(FAVORITES_KEY);
      return stored ? (JSON.parse(stored) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [recentAgents, setRecentAgents] = useState<string[]>(() => {
    if (typeof window === "undefined") {return [];}
    try {
      const stored = localStorage.getItem(RECENT_KEY);
      return stored ? (JSON.parse(stored) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Chat state - per agent
  const [chatStates, setChatStates] = useState<Record<string, AgentChatState>>(
    {}
  );

  // UI state
  const [inputValue, setInputValue] = useState("");
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  // Multi-agent mode
  const [multiAgentMode, setMultiAgentMode] = useState(false);
  const [selectedConsultants, setSelectedConsultants] = useState<string[]>([]);

  // Save to task modal
  const [showSaveTask, setShowSaveTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [savingTask, setSavingTask] = useState(false);

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Save favorites and recent to localStorage
  useEffect(() => {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentAgents));
  }, [recentAgents]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatStates, selectedAgent]);

  // Get current chat state
  const currentChat = useMemo(() => {
    if (!selectedAgent) {return null;}
    return (
      chatStates[selectedAgent.id] || {
        messages: [],
        isTyping: false,
        sessionKey: `agent:${selectedAgent.id}:mission-control:chat`,
      }
    );
  }, [chatStates, selectedAgent]);

  // Filter agents
  const filteredAgents = useMemo(() => {
    if (!searchQuery) {return SPECIALIZED_AGENTS;}
    const q = searchQuery.toLowerCase();
    return SPECIALIZED_AGENTS.filter(
      (a: SpecializedAgent) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.capabilities.some((c: string) => c.toLowerCase().includes(q))
    );
  }, [searchQuery]);

  // Group agents
  const favoriteAgents = useMemo(
    () => SPECIALIZED_AGENTS.filter((a: SpecializedAgent) => favorites.includes(a.id)),
    [favorites]
  );

  const recentAgentsList = useMemo(
    () =>
      recentAgents
        .map((id: string) => SPECIALIZED_AGENTS.find((a: SpecializedAgent) => a.id === id))
        .filter((a): a is SpecializedAgent => Boolean(a)),
    [recentAgents]
  );

  // Toggle favorite
  const toggleFavorite = useCallback((agentId: string) => {
    setFavorites((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId]
    );
  }, []);

  // Select agent
  const handleSelectAgent = useCallback(
    (agent: SpecializedAgent) => {
      setSelectedAgent(agent);
      // Add to recent (max 5)
      setRecentAgents((prev) => {
        const filtered = prev.filter((id) => id !== agent.id);
        return [agent.id, ...filtered].slice(0, 5);
      });
      // Initialize chat state if not exists
      if (!chatStates[agent.id]) {
        setChatStates((prev) => ({
          ...prev,
          [agent.id]: {
            messages: [],
            isTyping: false,
            sessionKey: `agent:${agent.id}:mission-control:chat`,
          },
        }));
      }
    },
    [chatStates]
  );

  // Toggle consultant for multi-agent mode
  const toggleConsultant = useCallback((agentId: string) => {
    setSelectedConsultants((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : prev.length < 3
          ? [...prev, agentId]
          : prev
    );
  }, []);

  const pollAssistantReply = useCallback(
    async (agentId: string, baseAssistantCount: number, pollAfterMs: number) => {
      const attempts = 25;
      const intervalMs = Math.max(pollAfterMs || 1200, 600);
      const sessionKey = `agent:${agentId}:mission-control:chat`;

      for (let attempt = 0; attempt < attempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        try {
          const res = await fetch(
            `/api/chat?sessionKey=${encodeURIComponent(sessionKey)}&limit=200`
          );
          const data = (await res.json()) as ChatApiResponse;
          const history = Array.isArray(data.messages) ? data.messages : [];
          const assistantMessages = history.filter((m) => m.role === "assistant");
          if (assistantMessages.length > baseAssistantCount) {
            return assistantMessages[assistantMessages.length - 1];
          }
        } catch {
          // Keep polling on transient errors.
        }
      }

      return null;
    },
    []
  );

  // Send message
  const sendMessage = useCallback(async () => {
    if (!inputValue.trim() || !selectedAgent || currentChat?.isTyping) {return;}

    const userMessage: ChatMessage = {
      id: generateId(),
      role: "user",
      content: inputValue.trim(),
      timestamp: new Date(),
    };

    // Update state with user message
    setChatStates((prev) => ({
      ...prev,
      [selectedAgent.id]: {
        ...prev[selectedAgent.id],
        messages: [...(prev[selectedAgent.id]?.messages || []), userMessage],
        isTyping: true,
      },
    }));

    setInputValue("");
    inputRef.current?.focus();

    // Determine which agents to consult
    const agentsToConsult =
      multiAgentMode && selectedConsultants.length > 0
        ? [
          selectedAgent.id,
          ...selectedConsultants.filter((id) => id !== selectedAgent.id),
        ]
        : [selectedAgent.id];

    // Send to each agent
    for (const agentId of agentsToConsult) {
      const agent = SPECIALIZED_AGENTS.find((a) => a.id === agentId);
      if (!agent) {continue;}

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: userMessage.content,
            sessionKey: `agent:${agentId}:mission-control:chat`,
            systemPrompt: agent.systemPrompt,
          }),
        });

        const data = (await res.json()) as ChatApiResponse;

        if (data.reply) {
          const assistantMessage: ChatMessage = {
            id: generateId(),
            role: "assistant",
            content:
              typeof data.reply === "string"
                ? data.reply
                : data.reply.content || "",
            timestamp: new Date(),
            agentId: agent.id,
            agentName: agent.name,
          };

          setChatStates((prev) => ({
            ...prev,
            [selectedAgent.id]: {
              ...prev[selectedAgent.id],
              messages: [
                ...(prev[selectedAgent.id]?.messages || []),
                assistantMessage,
              ],
            },
          }));
        } else if (data.queued) {
          const queuedReply = await pollAssistantReply(
            agentId,
            data.priorAssistantCount ?? 0,
            data.pollAfterMs || 1200
          );

          if (queuedReply) {
            const assistantMessage: ChatMessage = {
              id: generateId(),
              role: "assistant",
              content: queuedReply.content || "",
              timestamp: new Date(),
              agentId: agent.id,
              agentName: agent.name,
            };

            setChatStates((prev) => ({
              ...prev,
              [selectedAgent.id]: {
                ...prev[selectedAgent.id],
                messages: [
                  ...(prev[selectedAgent.id]?.messages || []),
                  assistantMessage,
                ],
              },
            }));
          } else {
            const timeoutMessage: ChatMessage = {
              id: generateId(),
              role: "assistant",
              content:
                "⏱️ The response is still processing. Refresh shortly for updates.",
              timestamp: new Date(),
              agentId: agent.id,
              agentName: agent.name,
            };

            setChatStates((prev) => ({
              ...prev,
              [selectedAgent.id]: {
                ...prev[selectedAgent.id],
                messages: [
                  ...(prev[selectedAgent.id]?.messages || []),
                  timeoutMessage,
                ],
              },
            }));
          }
        } else {
          const timeoutMessage: ChatMessage = {
            id: generateId(),
            role: "assistant",
            content:
              "No response returned from agent.",
            timestamp: new Date(),
            agentId: agent.id,
            agentName: agent.name,
          };

          setChatStates((prev) => ({
            ...prev,
            [selectedAgent.id]: {
              ...prev[selectedAgent.id],
              messages: [
                ...(prev[selectedAgent.id]?.messages || []),
                timeoutMessage,
              ],
            },
          }));
        }
      } catch (err) {
        console.error("Chat error:", err);
        const errorMessage: ChatMessage = {
          id: generateId(),
          role: "assistant",
          content: "❌ Failed to get response. Please try again.",
          timestamp: new Date(),
          agentId: agent.id,
          agentName: agent.name,
        };

        setChatStates((prev) => ({
          ...prev,
          [selectedAgent.id]: {
            ...prev[selectedAgent.id],
            messages: [
              ...(prev[selectedAgent.id]?.messages || []),
              errorMessage,
            ],
          },
        }));
      }
    }

    // Stop typing indicator
    setChatStates((prev) => ({
      ...prev,
      [selectedAgent.id]: {
        ...prev[selectedAgent.id],
        isTyping: false,
      },
    }));
  }, [
    inputValue,
    selectedAgent,
    currentChat,
    multiAgentMode,
    selectedConsultants,
    pollAssistantReply,
  ]);

  // Handle key press
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  // Copy system prompt
  const handleCopyPrompt = useCallback(async () => {
    if (!selectedAgent) {return;}
    await navigator.clipboard.writeText(selectedAgent.systemPrompt);
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2000);
  }, [selectedAgent]);

  // Export chat as markdown
  const exportChat = useCallback(() => {
    if (!selectedAgent || !currentChat?.messages.length) {return;}

    const md = [
      `# Chat with ${selectedAgent.name}`,
      `_Exported on ${new Date().toLocaleString()}_`,
      "",
      `**Agent:** ${selectedAgent.name}`,
      `**Category:** ${selectedAgent.category || "Specialist"}`,
      `**Description:** ${selectedAgent.description}`,
      "",
      "---",
      "",
      ...currentChat.messages.map((m) => {
        const sender =
          m.role === "user" ? "You" : m.agentName || selectedAgent.name;
        return `**${sender}** _${formatTimestamp(m.timestamp)}_\n\n${m.content}\n`;
      }),
    ].join("\n");

    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${selectedAgent.id}-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [selectedAgent, currentChat]);

  // Save to task
  const handleSaveTask = useCallback(async () => {
    if (!taskTitle.trim()) {return;}
    setSavingTask(true);

    try {
      const description =
        taskDescription ||
        (currentChat?.messages
          .slice(-5)
          .map((m) => `${m.role === "user" ? "User" : m.agentName}: ${m.content}`)
          .join("\n\n") || "");

      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: taskTitle,
          description: `**From chat with ${selectedAgent?.name}:**\n\n${description}`,
          priority: "medium",
          workspace_id: DEFAULT_WORKSPACE,
        }),
      });

      if (res.ok) {
        setShowSaveTask(false);
        setTaskTitle("");
        setTaskDescription("");
      }
    } catch (err) {
      console.error("Failed to save task:", err);
    }

    setSavingTask(false);
  }, [taskTitle, taskDescription, currentChat, selectedAgent]);

  // Clear chat
  const clearChat = useCallback(() => {
    if (!selectedAgent) {return;}
    setChatStates((prev) => ({
      ...prev,
      [selectedAgent.id]: {
        messages: [],
        isTyping: false,
        sessionKey: `agent:${selectedAgent.id}:mission-control:chat-${Date.now()}`,
      },
    }));
  }, [selectedAgent]);

  // ========== Render ==========

  return (
    <div className="flex h-full">
      {/* Sidebar - Agent Selector */}
      <div
        className={`border-r bg-card flex flex-col transition-all duration-300 ${sidebarCollapsed ? "w-16" : "w-80"
          }`}
      >
        {/* Sidebar Header */}
        <div className="p-4 border-b flex items-center justify-between">
          {!sidebarCollapsed && (
            <div className="flex items-center gap-2">
              <MessageSquare className="w-5 h-5 text-primary" />
              <span className="font-semibold">Agent Chat</span>
            </div>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            {sidebarCollapsed ? (
              <ChevronDown className="w-4 h-4 rotate-[-90deg]" />
            ) : (
              <ChevronUp className="w-4 h-4 rotate-[-90deg]" />
            )}
          </Button>
        </div>

        {!sidebarCollapsed && (
          <>
            {/* Search */}
            <div className="p-3 border-b">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Search agents..."
                  className="w-full pl-9 pr-3 py-2 text-sm border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  maxLength={200}
                />
              </div>
            </div>

            {/* Agent Lists */}
            <ScrollArea className="flex-1">
              <div className="p-3 space-y-4">
                {/* Favorites */}
                {favoriteAgents.length > 0 && !searchQuery && (
                  <div>
                    <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-2">
                      <Star className="w-3 h-3" />
                      FAVORITES
                    </div>
                    <div className="space-y-1">
                      {favoriteAgents.map((agent) => (
                        <AgentListItem
                          key={agent.id}
                          agent={agent}
                          isSelected={selectedAgent?.id === agent.id}
                          isFavorite={true}
                          onSelect={() => handleSelectAgent(agent)}
                          onToggleFavorite={() => toggleFavorite(agent.id)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Recent */}
                {recentAgentsList.length > 0 && !searchQuery && (
                  <div>
                    <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-2">
                      <Clock className="w-3 h-3" />
                      RECENT
                    </div>
                    <div className="space-y-1">
                      {recentAgentsList
                        .filter((a) => !favorites.includes(a.id))
                        .map((agent) => (
                          <AgentListItem
                            key={agent.id}
                            agent={agent}
                            isSelected={selectedAgent?.id === agent.id}
                            isFavorite={false}
                            onSelect={() => handleSelectAgent(agent)}
                            onToggleFavorite={() => toggleFavorite(agent.id)}
                          />
                        ))}
                    </div>
                  </div>
                )}

                {/* All Agents */}
                <div>
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-2">
                    <Bot className="w-3 h-3" />
                    {searchQuery ? "RESULTS" : "ALL AGENTS"}
                  </div>
                  <div className="space-y-1">
                    {filteredAgents.map((agent) => (
                      <AgentListItem
                        key={agent.id}
                        agent={agent}
                        isSelected={selectedAgent?.id === agent.id}
                        isFavorite={favorites.includes(agent.id)}
                        onSelect={() => handleSelectAgent(agent)}
                        onToggleFavorite={() => toggleFavorite(agent.id)}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </ScrollArea>
          </>
        )}

        {/* Collapsed state - icons only */}
        {sidebarCollapsed && (
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {SPECIALIZED_AGENTS.map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => handleSelectAgent(agent)}
                  className={`w-full p-2 rounded-lg flex items-center justify-center transition-colors ${selectedAgent?.id === agent.id
                    ? "bg-primary/10 ring-1 ring-primary"
                    : "hover:bg-muted"
                    } ${agent.color}`}
                  title={agent.name}
                >
                  <AgentIcon iconName={agent.icon} className="w-5 h-5" />
                </button>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col bg-background">
        {selectedAgent ? (
          <>
            {/* Agent Context Header */}
            <div className="border-b p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className={`w-12 h-12 rounded-lg flex items-center justify-center bg-muted ${selectedAgent.color}`}>
                    <AgentIcon iconName={selectedAgent.icon} className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="font-semibold text-lg">
                        {selectedAgent.name}
                      </h2>
                      <Badge
                        variant="outline"
                        className={selectedAgent.color}
                      >
                        {selectedAgent.category || "Specialist"}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      {selectedAgent.description}
                    </p>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {selectedAgent.capabilities.slice(0, 4).map((capability: string) => (
                        <Badge key={capability} variant="secondary" className="text-xs">
                          {capability}
                        </Badge>
                      ))}
                      {selectedAgent.capabilities.length > 4 && (
                        <Badge variant="secondary" className="text-xs">
                          +{selectedAgent.capabilities.length - 4} more
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>

                {/* Header Actions */}
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowSystemPrompt(!showSystemPrompt)}
                    title="Toggle system prompt"
                  >
                    {showSystemPrompt ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleFavorite(selectedAgent.id)}
                    title={favorites.includes(selectedAgent.id) ? "Remove from favorites" : "Add to favorites"}
                  >
                    {favorites.includes(selectedAgent.id) ? (
                      <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" />
                    ) : (
                      <StarOff className="w-4 h-4" />
                    )}
                  </Button>
                  <Button
                    variant={multiAgentMode ? "default" : "ghost"}
                    size="sm"
                    onClick={() => setMultiAgentMode(!multiAgentMode)}
                    title="Multi-agent consultation"
                  >
                    <Users className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* System Prompt (collapsible) */}
              {showSystemPrompt && (
                <div className="mt-4 bg-muted/30 border rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-medium flex items-center gap-2">
                      <Settings2 className="w-4 h-4" />
                      System Prompt
                    </h4>
                    <Button variant="ghost" size="sm" onClick={handleCopyPrompt}>
                      {copiedPrompt ? (
                        <>
                          <Check className="w-3 h-3 mr-1" />
                          Copied!
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3 mr-1" />
                          Copy
                        </>
                      )}
                    </Button>
                  </div>
                  <pre className="text-xs text-muted-foreground whitespace-pre-wrap bg-background/50 border rounded-md p-3 max-h-48 overflow-y-auto">
                    {selectedAgent.systemPrompt}
                  </pre>
                </div>
              )}

              {/* Multi-Agent Mode Panel */}
              {multiAgentMode && (
                <div className="mt-4 bg-primary/5 border border-primary/20 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-medium flex items-center gap-2">
                      <Users className="w-4 h-4 text-primary" />
                      Multi-Agent Consultation
                    </h4>
                    <span className="text-xs text-muted-foreground">
                      Select up to 3 additional agents
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {SPECIALIZED_AGENTS.filter(
                      (a) => a.id !== selectedAgent.id
                    ).map((agent) => (
                      <button
                        key={agent.id}
                        onClick={() => toggleConsultant(agent.id)}
                        className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-xs transition-colors ${selectedConsultants.includes(agent.id)
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted hover:bg-muted/80"
                          }`}
                      >
                        <span className={agent.color}><AgentIcon iconName={agent.icon} className="w-3 h-3" /></span>
                        <span>{agent.name}</span>
                        {selectedConsultants.includes(agent.id) && (
                          <X className="w-3 h-3" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Messages Area */}
            <ScrollArea className="flex-1 p-4">
              {currentChat?.messages.length === 0 ? (
                // Empty state with suggested prompts
                <div className="h-full flex flex-col items-center justify-center text-center p-8">
                  <div className={`w-16 h-16 rounded-xl flex items-center justify-center bg-muted mb-4 ${selectedAgent.color}`}>
                    <AgentIcon iconName={selectedAgent.icon} className="w-8 h-8" />
                  </div>
                  <h3 className="text-lg font-semibold mb-2">
                    Start a conversation with {selectedAgent.name}
                  </h3>
                  <p className="text-sm text-muted-foreground mb-6 max-w-md">
                    {selectedAgent.description}
                  </p>

                  {/* Suggested Prompts */}
                  <div className="w-full max-w-lg space-y-2">
                    <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-3">
                      <Sparkles className="w-3 h-3" />
                      SUGGESTED PROMPTS
                    </div>
                    {getSuggestedPrompts(selectedAgent).map((prompt, i) => (
                      <button
                        key={i}
                        onClick={() => setInputValue(prompt)}
                        className="w-full text-left p-3 rounded-lg border bg-card hover:bg-accent hover:border-primary/50 transition-colors text-sm"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                // Messages
                <div className="space-y-4 pb-4">
                  {currentChat?.messages.map((message, index) => {
                    const showDate =
                      index === 0 ||
                      formatDate(message.timestamp) !==
                      formatDate(
                        currentChat.messages[index - 1].timestamp
                      );

                    return (
                      <div key={message.id}>
                        {showDate && (
                          <div className="flex items-center justify-center my-4">
                            <span className="text-xs text-muted-foreground bg-muted px-3 py-1 rounded-full">
                              {formatDate(message.timestamp)}
                            </span>
                          </div>
                        )}
                        <MessageBubble
                          message={message}
                          agentIcon={
                            message.role === "assistant"
                              ? SPECIALIZED_AGENTS.find(
                                (a) => a.id === message.agentId
                              )?.icon || selectedAgent.icon
                              : undefined
                          }
                        />
                      </div>
                    );
                  })}

                  {/* Typing Indicator */}
                  {currentChat?.isTyping && (
                    <div className="flex items-start gap-3">
                      <div className={`w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 ${selectedAgent.color}`}>
                        <AgentIcon iconName={selectedAgent.icon} className="w-4 h-4" />
                      </div>
                      <div className="bg-muted rounded-2xl rounded-tl-sm px-4 py-3">
                        <div className="flex gap-1">
                          <span className="w-2 h-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
                          <span className="w-2 h-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
                          <span className="w-2 h-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </ScrollArea>

            {/* Input Area */}
            <div className="border-t p-4">
              {/* Action Buttons */}
              {currentChat && currentChat.messages.length > 0 && (
                <div className="flex items-center gap-2 mb-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowSaveTask(true)}
                  >
                    <ClipboardList className="w-4 h-4 mr-1" />
                    Save to Task
                  </Button>
                  <Button variant="outline" size="sm" onClick={exportChat}>
                    <Download className="w-4 h-4 mr-1" />
                    Export Chat
                  </Button>
                  <Button variant="ghost" size="sm" onClick={clearChat}>
                    <RefreshCw className="w-4 h-4 mr-1" />
                    Clear Chat
                  </Button>
                </div>
              )}

              {/* Input */}
              <div className="flex gap-2">
                <textarea
                  ref={inputRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={`Message ${selectedAgent.name}...`}
                  className="flex-1 min-h-[44px] max-h-32 px-4 py-3 rounded-lg border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring text-sm"
                  rows={1}
                  maxLength={5000}
                />
                <Button
                  onClick={sendMessage}
                  disabled={!inputValue.trim() || currentChat?.isTyping}
                  className="self-end"
                >
                  {currentChat?.isTyping ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </Button>
              </div>
            </div>
          </>
        ) : (
          // No agent selected state
          <div className="flex-1 flex items-center justify-center text-center p-8">
            <div>
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <MessageSquare className="w-8 h-8 text-primary" />
              </div>
              <h2 className="text-xl font-semibold mb-2">Select an Agent</h2>
              <p className="text-muted-foreground max-w-md">
                Choose a specialist from the sidebar to start a conversation.
                Each agent has unique expertise to help with your questions.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Save to Task Dialog */}
      <Dialog open={showSaveTask} onOpenChange={setShowSaveTask}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save Chat to Task</DialogTitle>
            <DialogDescription>
              Convert insights from this conversation into an actionable task.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Task Title</label>
              <input
                type="text"
                className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="e.g., Review portfolio allocation"
                maxLength={200}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Description (optional)
              </label>
              <textarea
                className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[100px] resize-y"
                value={taskDescription}
                onChange={(e) => setTaskDescription(e.target.value)}
                placeholder="Key points from the conversation..."
                maxLength={2000}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to include the last 5 messages automatically.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSaveTask(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveTask} disabled={savingTask || !taskTitle.trim()}>
              {savingTask ? (
                <>
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  Saving...
                </>
              ) : (
                "Create Task"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ========== Sub Components ==========

interface AgentListItemProps {
  agent: SpecializedAgent;
  isSelected: boolean;
  isFavorite: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
}

function AgentListItem({
  agent,
  isSelected,
  isFavorite,
  onSelect,
  onToggleFavorite,
}: AgentListItemProps) {
  return (
    <div
      className={`group flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors ${isSelected
        ? "bg-primary/10 ring-1 ring-primary"
        : "hover:bg-muted"
        }`}
      onClick={onSelect}
    >
      <span className="text-xl">{agent.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{agent.name}</div>
        <div className="text-xs text-muted-foreground truncate">
          {agent.category}
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
        className={`p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-background transition-opacity ${isFavorite ? "opacity-100" : ""
          }`}
      >
        {isFavorite ? (
          <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" />
        ) : (
          <Star className="w-3 h-3 text-muted-foreground" />
        )}
      </button>
    </div>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
  agentIcon?: string;
}

function MessageBubble({ message, agentIcon }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div className={`flex items-start gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      {/* Avatar */}
      {isUser ? (
        <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shrink-0">
          <span className="text-xs font-semibold text-primary-foreground">
            You
          </span>
        </div>
      ) : (
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <span className="text-lg">{agentIcon || "🤖"}</span>
        </div>
      )}

      {/* Message Content */}
      <div
        className={`max-w-[70%] ${isUser
          ? "bg-primary text-primary-foreground rounded-2xl rounded-tr-sm"
          : "bg-muted rounded-2xl rounded-tl-sm"
          } px-4 py-3`}
      >
        {/* Agent name for multi-agent mode */}
        {!isUser && message.agentName && (
          <div className="text-xs font-medium mb-1 opacity-70">
            {message.agentName}
          </div>
        )}
        {isUser ? (
          <div className="text-sm whitespace-pre-wrap">{message.content}</div>
        ) : message.content.includes("429") && message.content.toLowerCase().includes("limit") ? (
          <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4 mt-1 w-full max-w-sm">
            <div className="flex items-center gap-2 text-destructive font-medium mb-1.5 text-sm">
              <LucideIcons.AlertTriangle className="w-4 h-4" />
              Rate Limit Exceeded
            </div>
            <p className="text-xs text-destructive/80 leading-relaxed">
              The selected AI provider has reached its usage limit or is rate-limiting requests. Please try again later, or configure a fallback provider in your Settings.
            </p>
          </div>
        ) : (
          <ChatMarkdown content={String(message.content ?? "")} />
        )}
        <div
          className={`text-xs mt-1 ${isUser ? "text-primary-foreground/60" : "text-muted-foreground"
            }`}
        >
          {formatTimestamp(message.timestamp)}
        </div>
      </div>
    </div>
  );
}
