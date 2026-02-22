"use client";

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  createContext,
  useContext,
} from "react";
import {
  MessageSquare,
  Plus,
  Search,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Trash2,
  FolderPlus,
  Folder,
  FolderOpen,
  ChevronDown,
  Share2,
  Bot,
  X,
  Check,
  GripVertical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ============================================================================
// TYPES
// ============================================================================

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
}

export interface Chat {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  agentId?: string;
  folderId?: string | null;
}

export interface ChatFolder {
  id: string;
  name: string;
  createdAt: string;
  isExpanded: boolean;
}

interface ChatSidebarContextType {
  chats: Chat[];
  folders: ChatFolder[];
  activeChatId: string | null;
  isCollapsed: boolean;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  createNewChat: () => string;
  selectChat: (chatId: string) => void;
  deleteChat: (chatId: string) => void;
  renameChat: (chatId: string, newTitle: string) => void;
  createFolder: (name: string) => string;
  deleteFolder: (folderId: string) => void;
  renameFolder: (folderId: string, newName: string) => void;
  toggleFolder: (folderId: string) => void;
  moveChatToFolder: (chatId: string, folderId: string | null) => void;
  toggleSidebar: () => void;
  updateChat: (chatId: string, updates: Partial<Chat>) => void;
}

// ============================================================================
// CONTEXT
// ============================================================================

const ChatSidebarContext = createContext<ChatSidebarContextType | null>(null);

export function useChatSidebar() {
  const ctx = useContext(ChatSidebarContext);
  if (!ctx) {
    throw new Error("useChatSidebar must be used within ChatSidebarProvider");
  }
  return ctx;
}

// ============================================================================
// LOCAL STORAGE HELPERS
// ============================================================================

const STORAGE_KEYS = {
  CHATS: "mc-chat-history",
  FOLDERS: "mc-chat-folders",
  ACTIVE_CHAT: "mc-active-chat",
  SIDEBAR_COLLAPSED: "mc-sidebar-collapsed",
} as const;

function loadFromStorage<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") {return fallback;}
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  } catch {
    return fallback;
  }
}

function saveToStorage<T>(key: string, data: T): void {
  if (typeof window === "undefined") {return;}
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.error("Failed to save to localStorage:", e);
  }
}

// ============================================================================
// DATE GROUPING HELPERS
// ============================================================================

type DateGroup =
  | "Today"
  | "Yesterday"
  | "Previous 7 Days"
  | "This Month"
  | "Older";

function getDateGroup(dateString: string): DateGroup {
  const date = new Date(dateString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  if (date >= today) {return "Today";}
  if (date >= yesterday) {return "Yesterday";}
  if (date >= weekAgo) {return "Previous 7 Days";}
  if (date >= monthStart) {return "This Month";}
  return "Older";
}

function groupChatsByDate(chats: Chat[]): Map<DateGroup, Chat[]> {
  const groups = new Map<DateGroup, Chat[]>();
  const order: DateGroup[] = [
    "Today",
    "Yesterday",
    "Previous 7 Days",
    "This Month",
    "Older",
  ];

  order.forEach((group) => groups.set(group, []));

  chats.forEach((chat) => {
    const group = getDateGroup(chat.updatedAt);
    groups.get(group)?.push(chat);
  });

  // Sort chats within each group by updatedAt (newest first)
  groups.forEach((chatList) => {
    chatList.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  });

  return groups;
}

function formatTimestamp(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);

  if (hours < 1) {return "Just now";}
  if (hours < 24) {return `${hours}h ago`;}
  if (days === 1) {return "Yesterday";}
  if (days < 7) {return `${days}d ago`;}
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ============================================================================
// PROVIDER COMPONENT
// ============================================================================

interface ChatSidebarProviderProps {
  children: React.ReactNode;
  defaultCollapsed?: boolean;
}

export function ChatSidebarProvider({
  children,
  defaultCollapsed = false,
}: ChatSidebarProviderProps) {
  const [chats, setChats] = useState<Chat[]>(() =>
    loadFromStorage(STORAGE_KEYS.CHATS, [])
  );
  const [folders, setFolders] = useState<ChatFolder[]>(() =>
    loadFromStorage(STORAGE_KEYS.FOLDERS, [])
  );
  const [activeChatId, setActiveChatId] = useState<string | null>(() =>
    loadFromStorage(STORAGE_KEYS.ACTIVE_CHAT, null)
  );
  const [isCollapsed, setIsCollapsed] = useState(() =>
    loadFromStorage(STORAGE_KEYS.SIDEBAR_COLLAPSED, defaultCollapsed)
  );
  const [searchQuery, setSearchQuery] = useState("");
  const isHydrated = typeof window !== "undefined";

  // Persist to localStorage when state changes
  useEffect(() => {
    if (!isHydrated) {return;}
    saveToStorage(STORAGE_KEYS.CHATS, chats);
  }, [chats, isHydrated]);

  useEffect(() => {
    if (!isHydrated) {return;}
    saveToStorage(STORAGE_KEYS.FOLDERS, folders);
  }, [folders, isHydrated]);

  useEffect(() => {
    if (!isHydrated) {return;}
    saveToStorage(STORAGE_KEYS.ACTIVE_CHAT, activeChatId);
  }, [activeChatId, isHydrated]);

  useEffect(() => {
    if (!isHydrated) {return;}
    saveToStorage(STORAGE_KEYS.SIDEBAR_COLLAPSED, isCollapsed);
  }, [isCollapsed, isHydrated]);

  const createNewChat = useCallback(() => {
    const newChat: Chat = {
      id: crypto.randomUUID(),
      title: "New Chat",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      folderId: null,
    };
    setChats((prev) => [newChat, ...prev]);
    setActiveChatId(newChat.id);
    return newChat.id;
  }, []);

  const selectChat = useCallback((chatId: string) => {
    setActiveChatId(chatId);
  }, []);

  const deleteChat = useCallback(
    (chatId: string) => {
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      if (activeChatId === chatId) {
        setActiveChatId(null);
      }
    },
    [activeChatId]
  );

  const renameChat = useCallback((chatId: string, newTitle: string) => {
    setChats((prev) =>
      prev.map((c) =>
        c.id === chatId
          ? { ...c, title: newTitle, updatedAt: new Date().toISOString() }
          : c
      )
    );
  }, []);

  const updateChat = useCallback((chatId: string, updates: Partial<Chat>) => {
    setChats((prev) =>
      prev.map((c) =>
        c.id === chatId
          ? { ...c, ...updates, updatedAt: new Date().toISOString() }
          : c
      )
    );
  }, []);

  const createFolder = useCallback((name: string) => {
    const newFolder: ChatFolder = {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      isExpanded: true,
    };
    setFolders((prev) => [...prev, newFolder]);
    return newFolder.id;
  }, []);

  const deleteFolder = useCallback((folderId: string) => {
    // Move all chats from this folder to root
    setChats((prev) =>
      prev.map((c) => (c.folderId === folderId ? { ...c, folderId: null } : c))
    );
    setFolders((prev) => prev.filter((f) => f.id !== folderId));
  }, []);

  const renameFolder = useCallback((folderId: string, newName: string) => {
    setFolders((prev) =>
      prev.map((f) => (f.id === folderId ? { ...f, name: newName } : f))
    );
  }, []);

  const toggleFolder = useCallback((folderId: string) => {
    setFolders((prev) =>
      prev.map((f) =>
        f.id === folderId ? { ...f, isExpanded: !f.isExpanded } : f
      )
    );
  }, []);

  const moveChatToFolder = useCallback(
    (chatId: string, folderId: string | null) => {
      setChats((prev) =>
        prev.map((c) =>
          c.id === chatId
            ? { ...c, folderId, updatedAt: new Date().toISOString() }
            : c
        )
      );
    },
    []
  );

  const toggleSidebar = useCallback(() => {
    setIsCollapsed((prev) => !prev);
  }, []);

  const contextValue: ChatSidebarContextType = {
    chats,
    folders,
    activeChatId,
    isCollapsed,
    searchQuery,
    setSearchQuery,
    createNewChat,
    selectChat,
    deleteChat,
    renameChat,
    createFolder,
    deleteFolder,
    renameFolder,
    toggleFolder,
    moveChatToFolder,
    toggleSidebar,
    updateChat,
  };

  return (
    <ChatSidebarContext.Provider value={contextValue}>
      {children}
    </ChatSidebarContext.Provider>
  );
}

// ============================================================================
// CONTEXT MENU
// ============================================================================

interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  chatId: string | null;
  folderId: string | null;
}

interface ContextMenuProps {
  state: ContextMenuState;
  onClose: () => void;
}

function ContextMenu({ state, onClose }: ContextMenuProps) {
  const {
    deleteChat,
    renameChat,
    moveChatToFolder,
    folders,
    deleteFolder,
    renameFolder,
    chats,
  } = useChatSidebar();
  const menuRef = useRef<HTMLDivElement>(null);
  const [showFolderSubmenu, setShowFolderSubmenu] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") {onClose();}
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  if (!state.isOpen) {return null;}

  const chat = state.chatId
    ? chats.find((c) => c.id === state.chatId)
    : null;
  const folder = state.folderId
    ? folders.find((f) => f.id === state.folderId)
    : null;

  const handleRename = () => {
    if (state.chatId && chat) {
      setRenameValue(chat.title);
      setIsRenaming(true);
    } else if (state.folderId && folder) {
      setRenameValue(folder.name);
      setIsRenaming(true);
    }
  };

  const submitRename = () => {
    if (state.chatId) {
      renameChat(state.chatId, renameValue);
    } else if (state.folderId) {
      renameFolder(state.folderId, renameValue);
    }
    onClose();
  };

  const handleDelete = () => {
    if (state.chatId) {
      deleteChat(state.chatId);
    } else if (state.folderId) {
      deleteFolder(state.folderId);
    }
    onClose();
  };

  const handleShare = () => {
    if (state.chatId) {
      const url = `${window.location.origin}/chat/${state.chatId}`;
      navigator.clipboard.writeText(url);
      // Could add toast notification here
    }
    onClose();
  };

  const handleMoveToFolder = (folderId: string | null) => {
    if (state.chatId) {
      moveChatToFolder(state.chatId, folderId);
    }
    onClose();
  };

  // Calculate position to keep menu in viewport
  const menuStyle: React.CSSProperties = {
    position: "fixed",
    left: Math.min(state.x, window.innerWidth - 200),
    top: Math.min(state.y, window.innerHeight - 250),
    zIndex: 100,
  };

  if (isRenaming) {
    return (
      <div
        ref={menuRef}
        style={menuStyle}
        className="bg-popover border border-border rounded-lg shadow-lg p-2 min-w-[200px] scale-in"
      >
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {submitRename();}
              if (e.key === "Escape") {onClose();}
            }}
            autoFocus
            maxLength={200}
            className="flex-1 bg-background border border-input rounded px-2 py-1.5 text-sm outline-none focus:border-primary"
          />
          <Button size="icon-xs" variant="ghost" onClick={submitRename}>
            <Check className="w-3.5 h-3.5" />
          </Button>
          <Button size="icon-xs" variant="ghost" onClick={onClose}>
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={menuRef}
      style={menuStyle}
      className="bg-popover border border-border rounded-lg shadow-lg py-1 min-w-[180px] scale-in"
    >
      {state.chatId && (
        <>
          <button
            onClick={handleRename}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-accent transition-colors"
          >
            <Pencil className="w-4 h-4" />
            Rename
          </button>
          <div
            className="relative"
            onMouseEnter={() => setShowFolderSubmenu(true)}
            onMouseLeave={() => setShowFolderSubmenu(false)}
          >
            <button className="flex items-center justify-between gap-2 w-full px-3 py-2 text-sm hover:bg-accent transition-colors">
              <span className="flex items-center gap-2">
                <Folder className="w-4 h-4" />
                Move to folder
              </span>
              <ChevronRight className="w-4 h-4" />
            </button>
            {showFolderSubmenu && (
              <div className="absolute left-full top-0 ml-1 bg-popover border border-border rounded-lg shadow-lg py-1 min-w-[150px]">
                <button
                  onClick={() => handleMoveToFolder(null)}
                  className={cn(
                    "flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-accent transition-colors",
                    chat?.folderId === null && "text-primary"
                  )}
                >
                  <MessageSquare className="w-4 h-4" />
                  No folder
                </button>
                <div className="border-t border-border my-1" />
                {folders.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => handleMoveToFolder(f.id)}
                    className={cn(
                      "flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-accent transition-colors",
                      chat?.folderId === f.id && "text-primary"
                    )}
                  >
                    <Folder className="w-4 h-4" />
                    {f.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={handleShare}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-accent transition-colors"
          >
            <Share2 className="w-4 h-4" />
            Share (copy link)
          </button>
          <div className="border-t border-border my-1" />
          <button
            onClick={handleDelete}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            Delete
          </button>
        </>
      )}
      {state.folderId && (
        <>
          <button
            onClick={handleRename}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-accent transition-colors"
          >
            <Pencil className="w-4 h-4" />
            Rename folder
          </button>
          <div className="border-t border-border my-1" />
          <button
            onClick={handleDelete}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            Delete folder
          </button>
        </>
      )}
    </div>
  );
}

// ============================================================================
// CHAT ITEM COMPONENT
// ============================================================================

interface ChatItemProps {
  chat: Chat;
  onContextMenu: (e: React.MouseEvent, chatId: string) => void;
  onDragStart?: (e: React.DragEvent, chatId: string) => void;
}

function ChatItem({ chat, onContextMenu, onDragStart }: ChatItemProps) {
  const { activeChatId, selectChat, renameChat, deleteChat } = useChatSidebar();
  const [isHovered, setIsHovered] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(chat.title);
  const inputRef = useRef<HTMLInputElement>(null);

  const isActive = activeChatId === chat.id;
  const preview =
    chat.messages.find((m) => m.role === "user")?.content || "New conversation";

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSaveEdit = () => {
    if (editValue.trim()) {
      renameChat(chat.id, editValue.trim());
    }
    setIsEditing(false);
  };

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart?.(e, chat.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e, chat.id);
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={() => !isEditing && selectChat(chat.id)}
      className={cn(
        "group relative flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all",
        isActive
          ? "bg-primary/10 text-primary border border-primary/20"
          : "hover:bg-accent/50 border border-transparent"
      )}
    >
      {/* Drag handle */}
      <div
        className={cn(
          "opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity cursor-grab",
          isActive && "opacity-50"
        )}
      >
        <GripVertical className="w-3.5 h-3.5 text-muted-foreground" />
      </div>

      {/* Chat icon */}
      <div
        className={cn(
          "shrink-0 w-8 h-8 rounded-lg flex items-center justify-center",
          isActive
            ? "bg-primary/20 text-primary"
            : "bg-muted text-muted-foreground"
        )}
      >
        {chat.agentId ? (
          <Bot className="w-4 h-4" />
        ) : (
          <MessageSquare className="w-4 h-4" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleSaveEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {handleSaveEdit();}
              if (e.key === "Escape") {
                setEditValue(chat.title);
                setIsEditing(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            maxLength={200}
            className="w-full bg-background border border-primary rounded px-1.5 py-0.5 text-sm outline-none"
          />
        ) : (
          <>
            <div className="font-medium text-sm truncate">{chat.title}</div>
            <div className="text-xs text-muted-foreground truncate">
              {preview.substring(0, 50)}
              {preview.length > 50 ? "..." : ""}
            </div>
          </>
        )}
      </div>

      {/* Timestamp & Actions */}
      <div className="shrink-0 flex items-center gap-1">
        {!isHovered && !isEditing && (
          <span className="text-[10px] text-muted-foreground">
            {formatTimestamp(chat.updatedAt)}
          </span>
        )}
        {isHovered && !isEditing && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditValue(chat.title);
                    setIsEditing(true);
                  }}
                  className="h-6 w-6 opacity-70 hover:opacity-100"
                >
                  <Pencil className="w-3 h-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Rename</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteChat(chat.id);
                  }}
                  className="h-6 w-6 opacity-70 hover:opacity-100 hover:text-destructive"
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>

      {/* Agent badge */}
      {chat.agentId && (
        <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-primary flex items-center justify-center">
          <Bot className="w-2.5 h-2.5 text-primary-foreground" />
        </div>
      )}
    </div>
  );
}

// ============================================================================
// FOLDER COMPONENT
// ============================================================================

interface FolderItemProps {
  folder: ChatFolder;
  chats: Chat[];
  onContextMenu: (e: React.MouseEvent, folderId: string) => void;
  onChatContextMenu: (e: React.MouseEvent, chatId: string) => void;
  onDragStart: (e: React.DragEvent, chatId: string) => void;
  onDrop: (e: React.DragEvent, folderId: string) => void;
}

function FolderItem({
  folder,
  chats,
  onContextMenu,
  onChatContextMenu,
  onDragStart,
  onDrop,
}: FolderItemProps) {
  const { toggleFolder, renameFolder } = useChatSidebar();
  const [isDragOver, setIsDragOver] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(folder.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSaveEdit = () => {
    if (editValue.trim()) {
      renameFolder(folder.id, editValue.trim());
    }
    setIsEditing(false);
  };

  const folderChats = chats.filter((c) => c.folderId === folder.id);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        setIsDragOver(false);
        onDrop(e, folder.id);
      }}
      className={cn(
        "rounded-lg transition-colors",
        isDragOver && "bg-primary/10 ring-2 ring-primary/30"
      )}
    >
      {/* Folder header */}
      <div
        onClick={() => !isEditing && toggleFolder(folder.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e, folder.id);
        }}
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-accent/50 rounded-lg transition-colors"
      >
        <div className="text-muted-foreground">
          {folder.isExpanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
        </div>
        {folder.isExpanded ? (
          <FolderOpen className="w-4 h-4 text-primary" />
        ) : (
          <Folder className="w-4 h-4 text-muted-foreground" />
        )}
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleSaveEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {handleSaveEdit();}
              if (e.key === "Escape") {
                setEditValue(folder.name);
                setIsEditing(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            maxLength={200}
            className="flex-1 bg-background border border-primary rounded px-1.5 py-0.5 text-sm outline-none"
          />
        ) : (
          <span className="flex-1 text-sm font-medium truncate">
            {folder.name}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {folderChats.length}
        </span>
      </div>

      {/* Folder contents */}
      {folder.isExpanded && folderChats.length > 0 && (
        <div className="ml-4 pl-2 border-l border-border space-y-1 pb-2">
          {folderChats.map((chat) => (
            <ChatItem
              key={chat.id}
              chat={chat}
              onContextMenu={onChatContextMenu}
              onDragStart={onDragStart}
            />
          ))}
        </div>
      )}

      {/* Empty folder state */}
      {folder.isExpanded && folderChats.length === 0 && (
        <div className="ml-4 pl-2 border-l border-border py-3">
          <p className="text-xs text-muted-foreground italic">
            Drag chats here
          </p>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// DATE GROUP COMPONENT
// ============================================================================

interface DateGroupProps {
  title: DateGroup;
  chats: Chat[];
  onContextMenu: (e: React.MouseEvent, chatId: string) => void;
  onDragStart: (e: React.DragEvent, chatId: string) => void;
}

function DateGroupSection({
  title,
  chats,
  onContextMenu,
  onDragStart,
}: DateGroupProps) {
  if (chats.length === 0) {return null;}

  return (
    <div className="space-y-1">
      <h3 className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {title}
      </h3>
      {chats.map((chat) => (
        <ChatItem
          key={chat.id}
          chat={chat}
          onContextMenu={onContextMenu}
          onDragStart={onDragStart}
        />
      ))}
    </div>
  );
}

// ============================================================================
// MAIN SIDEBAR COMPONENT
// ============================================================================

interface ChatSidebarProps {
  className?: string;
}

export function ChatSidebar({ className }: ChatSidebarProps) {
  const {
    chats,
    folders,
    isCollapsed,
    searchQuery,
    setSearchQuery,
    createNewChat,
    createFolder,
    toggleSidebar,
    moveChatToFolder,
  } = useChatSidebar();

  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    isOpen: false,
    x: 0,
    y: 0,
    chatId: null,
    folderId: null,
  });
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [draggedChatId, setDraggedChatId] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isCreatingFolder && folderInputRef.current) {
      folderInputRef.current.focus();
    }
  }, [isCreatingFolder]);

  // Filter chats based on search query
  const filteredChats = useMemo(() => {
    if (!searchQuery.trim()) {return chats;}
    const q = searchQuery.toLowerCase();
    return chats.filter(
      (chat) =>
        chat.title.toLowerCase().includes(q) ||
        chat.messages.some((m) => m.content.toLowerCase().includes(q))
    );
  }, [chats, searchQuery]);

  // Separate chats into folders and ungrouped
  const ungroupedChats = useMemo(
    () => filteredChats.filter((c) => !c.folderId),
    [filteredChats]
  );

  const groupedByDate = useMemo(
    () => groupChatsByDate(ungroupedChats),
    [ungroupedChats]
  );

  const handleChatContextMenu = (e: React.MouseEvent, chatId: string) => {
    setContextMenu({
      isOpen: true,
      x: e.clientX,
      y: e.clientY,
      chatId,
      folderId: null,
    });
  };

  const handleFolderContextMenu = (e: React.MouseEvent, folderId: string) => {
    setContextMenu({
      isOpen: true,
      x: e.clientX,
      y: e.clientY,
      chatId: null,
      folderId,
    });
  };

  const handleDragStart = (e: React.DragEvent, chatId: string) => {
    setDraggedChatId(chatId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", chatId);
  };

  const handleDrop = (e: React.DragEvent, folderId: string) => {
    e.preventDefault();
    const chatId = e.dataTransfer.getData("text/plain") || draggedChatId;
    if (chatId) {
      moveChatToFolder(chatId, folderId);
    }
    setDraggedChatId(null);
  };

  const handleRootDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const chatId = e.dataTransfer.getData("text/plain") || draggedChatId;
    if (chatId) {
      moveChatToFolder(chatId, null);
    }
    setDraggedChatId(null);
  };

  const handleCreateFolder = () => {
    if (newFolderName.trim()) {
      createFolder(newFolderName.trim());
      setNewFolderName("");
      setIsCreatingFolder(false);
    }
  };

  return (
    <>
      <aside
        className={cn(
          "relative flex flex-col bg-card/50 border-r border-border transition-all duration-300 ease-in-out z-10",
          isCollapsed ? "w-0 overflow-hidden" : "w-[280px]",
          className
        )}
      >
        {/* Header */}
        <div className="shrink-0 p-3 border-b border-border space-y-3">
          {/* New Chat Button */}
          <Button
            onClick={() => createNewChat()}
            className="w-full justify-start gap-2 bg-primary hover:bg-primary/90 text-primary-foreground shadow-[0_0_10px_var(--mc-glow)]"
          >
            <Plus className="w-4 h-4" />
            New Chat
          </Button>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search chats..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              maxLength={200}
              className="w-full bg-background border border-input rounded-lg pl-9 pr-3 py-2 text-sm outline-none focus:border-primary transition-colors placeholder:text-muted-foreground"
            />
            {searchQuery && (
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2"
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        </div>

        {/* Chat List */}
        <ScrollArea className="flex-1">
          <div
            className="p-2 space-y-4"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleRootDrop}
          >
            {/* Folders */}
            {folders.length > 0 && (
              <div className="space-y-1">
                <h3 className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
                  Folders
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => setIsCreatingFolder(true)}
                        className="h-5 w-5"
                      >
                        <FolderPlus className="w-3.5 h-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>New folder</TooltipContent>
                  </Tooltip>
                </h3>
                {folders.map((folder) => (
                  <FolderItem
                    key={folder.id}
                    folder={folder}
                    chats={filteredChats}
                    onContextMenu={handleFolderContextMenu}
                    onChatContextMenu={handleChatContextMenu}
                    onDragStart={handleDragStart}
                    onDrop={handleDrop}
                  />
                ))}
              </div>
            )}

            {/* New Folder Input */}
            {isCreatingFolder && (
              <div className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <Folder className="w-4 h-4 text-muted-foreground shrink-0" />
                  <input
                    ref={folderInputRef}
                    type="text"
                    placeholder="Folder name..."
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {handleCreateFolder();}
                      if (e.key === "Escape") {
                        setNewFolderName("");
                        setIsCreatingFolder(false);
                      }
                    }}
                    onBlur={() => {
                      if (!newFolderName.trim()) {
                        setIsCreatingFolder(false);
                      }
                    }}
                    maxLength={200}
                    className="flex-1 bg-background border border-primary rounded px-2 py-1 text-sm outline-none"
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={handleCreateFolder}
                  >
                    <Check className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => {
                      setNewFolderName("");
                      setIsCreatingFolder(false);
                    }}
                  >
                    <X className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            )}

            {/* Create folder button if no folders exist */}
            {folders.length === 0 && !isCreatingFolder && (
              <div className="px-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsCreatingFolder(true)}
                  className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
                >
                  <FolderPlus className="w-4 h-4" />
                  Create folder
                </Button>
              </div>
            )}

            {/* Ungrouped chats by date */}
            {Array.from(groupedByDate.entries()).map(([group, groupChats]) => (
              <DateGroupSection
                key={group}
                title={group}
                chats={groupChats}
                onContextMenu={handleChatContextMenu}
                onDragStart={handleDragStart}
              />
            ))}

            {/* Empty state */}
            {filteredChats.length === 0 && (
              <div className="py-12 text-center">
                <MessageSquare className="w-10 h-10 mx-auto text-muted-foreground/50 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {searchQuery ? "No chats found" : "No conversations yet"}
                </p>
                {!searchQuery && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => createNewChat()}
                    className="mt-2"
                  >
                    Start a new chat
                  </Button>
                )}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="shrink-0 p-3 border-t border-border">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {chats.length} chat{chats.length !== 1 ? "s" : ""}
            </span>
            <span>
              {folders.length} folder{folders.length !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
      </aside>

      {/* Toggle button (always visible) */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={toggleSidebar}
            className={cn(
              "fixed z-20 transition-all duration-300",
              isCollapsed ? "left-20" : "left-[336px]",
              "top-20 bg-card border border-border shadow-md hover:shadow-lg"
            )}
          >
            {isCollapsed ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {isCollapsed ? "Show chat history" : "Hide chat history"}
        </TooltipContent>
      </Tooltip>

      {/* Context Menu */}
      <ContextMenu
        state={contextMenu}
        onClose={() =>
          setContextMenu((s) => ({ ...s, isOpen: false, chatId: null, folderId: null }))
        }
      />
    </>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { ChatSidebarContextType };
