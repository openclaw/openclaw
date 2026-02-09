import React, { useState, useEffect } from "react";
import { X, Trash2, MessageSquare, Search } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { loadConversations, deleteConversation } from "../lib/chat";
import type { Conversation } from "../lib/types";

interface ChatHistoryProps {
  isOpen: boolean;
  onClose: () => void;
  theme: "dark" | "light";
  onSelectChat: (chatId: string) => void;
  refreshKey?: number;
}

interface ChatItem {
  id: string;
  title: string;
  preview: string;
  timestamp: Date;
  messageCount: number;
  model?: string;
}

export const ChatHistory: React.FC<ChatHistoryProps> = ({ 
  isOpen, 
  onClose, 
  theme, 
  onSelectChat,
  refreshKey = 0 
}) => {
  const isDark = theme === "dark";
  const [searchQuery, setSearchQuery] = useState("");
  const [chats, setChats] = useState<ChatItem[]>([]);

  // Load chat history from localStorage
  useEffect(() => {
    const conversations = loadConversations();
    const chatItems: ChatItem[] = Object.values(conversations)
      .map((conv: Conversation) => ({
        id: conv.id,
        title: conv.title,
        preview: conv.messages?.[conv.messages.length - 1]?.content?.slice(0, 80) || "Empty conversation",
        timestamp: new Date(conv.updatedAt || conv.createdAt),
        messageCount: conv.messages?.length || 0,
        model: conv.model,
      }))
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    
    setChats(chatItems);
  }, [isOpen, refreshKey]);

  const handleDeleteChat = (chatId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    deleteConversation(chatId);
    setChats(prev => prev.filter(c => c.id !== chatId));
  };

  const formatDate = (date: Date) => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const filteredChats = chats.filter(
    (chat) =>
      chat.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      chat.preview.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Group chats by date
  const groupedChats = filteredChats.reduce((groups, chat) => {
    const now = new Date();
    const chatDate = chat.timestamp;
    const diffDays = Math.floor((now.getTime() - chatDate.getTime()) / (1000 * 60 * 60 * 24));

    let group: string;
    if (diffDays === 0) group = "Today";
    else if (diffDays === 1) group = "Yesterday";
    else if (diffDays < 7) group = "This Week";
    else group = "Older";

    if (!groups[group]) groups[group] = [];
    groups[group].push(chat);
    return groups;
  }, {} as Record<string, ChatItem[]>);

  // Order for groups
  const groupOrder = ["Today", "Yesterday", "This Week", "Older"];

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ x: -300, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: -300, opacity: 0 }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          className={`fixed left-[68px] top-0 z-40 h-full w-[320px] border-r shadow-xl ${
            isDark ? "bg-[#0d0d0d] border-white/5" : "bg-[#fcfcfc] border-black/5"
          }`}
        >
          {/* Header */}
          <div className={`flex items-center justify-between px-4 py-4 border-b ${
            isDark ? "border-white/5" : "border-black/5"
          }`}>
            <h2 className={`text-base font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>
              Chat History
            </h2>
            <button
              onClick={onClose}
              className={`p-2 rounded-lg transition-colors ${
                isDark ? "hover:bg-white/10 text-gray-400" : "hover:bg-gray-100 text-gray-500"
              }`}
            >
              <X size={18} />
            </button>
          </div>

          {/* Search */}
          <div className="px-4 py-3">
            <div className={`relative`}>
              <Search size={16} className={`absolute left-3 top-1/2 -translate-y-1/2 ${
                isDark ? "text-gray-500" : "text-gray-400"
              }`} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search conversations..."
                className={`w-full pl-10 pr-4 py-2.5 rounded-xl border text-sm transition-colors ${
                  isDark
                    ? "bg-white/5 border-white/10 text-white placeholder-gray-500 focus:border-[#2dd4bf]/50"
                    : "bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-[#2dd4bf]"
                } outline-none`}
              />
            </div>
          </div>

          {/* Chat List */}
          <div className="overflow-y-auto h-[calc(100%-120px)] px-2">
            {groupOrder
              .filter(group => groupedChats[group]?.length > 0)
              .map((group) => (
              <div key={group} className="mb-4">
                <div className={`px-2 py-2 text-xs font-medium uppercase tracking-wider ${
                  isDark ? "text-gray-500" : "text-gray-400"
                }`}>
                  {group}
                </div>
                {groupedChats[group].map((chat) => (
                  <motion.div
                    key={chat.id}
                    whileHover={{ scale: 1.02 }}
                    onClick={() => onSelectChat(chat.id)}
                    className={`group relative p-3 rounded-xl mb-1 cursor-pointer transition-colors ${
                      isDark ? "hover:bg-white/5" : "hover:bg-black/5"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`p-2 rounded-lg shrink-0 ${
                        isDark ? "bg-white/5" : "bg-gray-100"
                      }`}>
                        <MessageSquare size={16} className={isDark ? "text-gray-400" : "text-gray-500"} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <h3 className={`text-sm font-medium truncate ${
                            isDark ? "text-white" : "text-gray-900"
                          }`}>
                            {chat.title}
                          </h3>
                          <span className={`text-xs shrink-0 ${
                            isDark ? "text-gray-500" : "text-gray-400"
                          }`}>
                            {formatDate(chat.timestamp)}
                          </span>
                        </div>
                        <p className={`text-xs mt-1 truncate ${
                          isDark ? "text-gray-500" : "text-gray-500"
                        }`}>
                          {chat.preview}
                        </p>
                        <div className={`text-xs mt-1 ${
                          isDark ? "text-gray-600" : "text-gray-400"
                        }`}>
                          {chat.messageCount} messages
                        </div>
                      </div>
                    </div>
                    
                    {/* Delete button */}
                    <button
                      onClick={(e) => handleDeleteChat(chat.id, e)}
                      className={`absolute right-2 top-2 p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-all ${
                        isDark 
                          ? "hover:bg-red-500/20 text-gray-500 hover:text-red-400" 
                          : "hover:bg-red-50 text-gray-400 hover:text-red-500"
                      }`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </motion.div>
                ))}
              </div>
            ))}

            {filteredChats.length === 0 && (
              <div className={`text-center py-12 ${isDark ? "text-gray-500" : "text-gray-400"}`}>
                <MessageSquare size={32} className="mx-auto mb-3 opacity-50" />
                <p className="text-sm">
                  {chats.length === 0 
                    ? "No conversations yet. Start chatting!" 
                    : "No conversations found"
                  }
                </p>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
