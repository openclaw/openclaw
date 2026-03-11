import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

type ChatState = {
  isMinimized: boolean;
  lastActiveAgent: string;
  toggleChat: () => void;
  minimizeChat: () => void;
  maximizeChat: () => void;
  setLastActiveAgent: (agentId: string) => void;
};

const ChatContext = createContext<ChatState | null>(null);

const STORAGE_KEY = "mabos-chat-state";

type PersistedChatState = {
  isMinimized: boolean;
  lastActiveAgent: string;
};

function loadPersistedState(): PersistedChatState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        isMinimized: Boolean(parsed.isMinimized),
        lastActiveAgent: String(parsed.lastActiveAgent || "ceo"),
      };
    }
  } catch {
    /* ignore parse errors */
  }
  return { isMinimized: false, lastActiveAgent: "ceo" };
}

function persistState(state: PersistedChatState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore storage errors */
  }
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const [isMinimized, setIsMinimized] = useState(() => loadPersistedState().isMinimized);
  const [lastActiveAgent, setLastActiveAgentState] = useState(
    () => loadPersistedState().lastActiveAgent,
  );

  useEffect(() => {
    persistState({ isMinimized, lastActiveAgent });
  }, [isMinimized, lastActiveAgent]);

  const toggleChat = useCallback(() => setIsMinimized((m) => !m), []);
  const minimizeChat = useCallback(() => setIsMinimized(true), []);
  const maximizeChat = useCallback(() => setIsMinimized(false), []);
  const setLastActiveAgent = useCallback((agentId: string) => {
    setLastActiveAgentState(agentId);
  }, []);

  return (
    <ChatContext.Provider
      value={{
        isMinimized,
        lastActiveAgent,
        toggleChat,
        minimizeChat,
        maximizeChat,
        setLastActiveAgent,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChatState() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChatState must be used within a ChatProvider");
  return ctx;
}
