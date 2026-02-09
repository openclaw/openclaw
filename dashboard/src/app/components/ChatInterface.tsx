import React, { useRef, useEffect, useState, useCallback } from "react";
import { ChevronDown, ArrowUp, Paperclip, Globe, Zap, Sparkles, Command, User, Bot, AlertCircle, Loader2, Copy, Check, X, File, Image as ImageIcon } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { sendMessageStream } from "../lib/chat";
import { generateId, generateTitle, type Message, type Conversation, type ChatSettings } from "../lib/types";
import { saveConversation, getConversation } from "../lib/chat";
import { PROVIDERS, type ProviderKey } from "../lib/easyhub";

interface ChatInterfaceProps {
  theme: "dark" | "light";
  chatId?: string | null;
  onConversationUpdate?: () => void;
}

interface Attachment {
  id: string;
  file: File;
  preview?: string;
  type: "image" | "file";
}

const QUICK_ACTIONS = [
  { label: "Search", icon: Globe, prompt: "Search the web for " },
  { label: "Analyze", icon: Zap, prompt: "Analyze this: " },
  { label: "Summarize", icon: Sparkles, prompt: "Summarize: " },
  { label: "Code", icon: Command, prompt: "Write code to " },
];

const SUGGESTIONS = [
  "Write a marketing plan for a tech startup",
  "Explain quantum computing in simple terms",
  "How do I optimize my React application?",
];

// Markdown-like renderer (basic)
function renderContent(content: string, isDark: boolean) {
  const parts = content.split(/(```[\s\S]*?```)/g);
  
  return parts.map((part, idx) => {
    if (part.startsWith("```")) {
      const match = part.match(/```(\w+)?\n?([\s\S]*?)```/);
      const lang = match?.[1] || "";
      const code = match?.[2] || part.slice(3, -3);
      
      return (
        <pre
          key={idx}
          className={`my-3 p-4 rounded-xl overflow-x-auto text-sm font-mono ${
            isDark ? "bg-black/40" : "bg-gray-100"
          }`}
        >
          {lang && (
            <div className={`text-xs mb-2 ${isDark ? "text-gray-500" : "text-gray-400"}`}>
              {lang}
            </div>
          )}
          <code>{code}</code>
        </pre>
      );
    }
    
    const inlineFormatted = part.split(/(`[^`]+`)/g).map((segment, i) => {
      if (segment.startsWith("`") && segment.endsWith("`")) {
        return (
          <code
            key={i}
            className={`px-1.5 py-0.5 rounded text-sm font-mono ${
              isDark ? "bg-white/10" : "bg-gray-200"
            }`}
          >
            {segment.slice(1, -1)}
          </code>
        );
      }
      return segment;
    });
    
    return <span key={idx}>{inlineFormatted}</span>;
  });
}

// Message component
function MessageBubble({ 
  message, 
  isDark 
}: { 
  message: Message; 
  isDark: boolean;
}) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`group flex gap-4 ${isUser ? "justify-end" : "justify-start"}`}
    >
      {!isUser && (
        <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
          isDark ? "bg-[#2dd4bf]/20" : "bg-[#2dd4bf]/10"
        }`}>
          <Bot size={18} className="text-[#2dd4bf]" />
        </div>
      )}
      
      <div className={`relative max-w-[80%] ${isUser ? "order-first" : ""}`}>
        <div
          className={`px-4 py-3 rounded-2xl text-[15px] leading-relaxed ${
            isUser
              ? "bg-[#2dd4bf] text-black rounded-br-md"
              : isDark
                ? "bg-white/5 text-gray-200 rounded-bl-md"
                : "bg-gray-100 text-gray-800 rounded-bl-md"
          }`}
        >
          {isUser ? message.content : renderContent(message.content, isDark)}
        </div>
        
        {!isUser && (
          <button
            onClick={handleCopy}
            className={`absolute -bottom-6 left-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-xs ${
              isDark ? "text-gray-500 hover:text-gray-300" : "text-gray-400 hover:text-gray-600"
            }`}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      
      {isUser && (
        <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
          isDark ? "bg-white/10" : "bg-gray-200"
        }`}>
          <User size={18} className={isDark ? "text-gray-400" : "text-gray-600"} />
        </div>
      )}
    </motion.div>
  );
}

export const ChatInterface: React.FC<ChatInterfaceProps> = ({ 
  theme, 
  chatId,
  onConversationUpdate 
}) => {
  const isDark = theme === "dark";
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  const [value, setValue] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState("");
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
  
  // Model selection state
  const [selectedProvider, setSelectedProvider] = useState<ProviderKey>("anthropic");
  const [selectedModel, setSelectedModel] = useState("claude-sonnet-4-20250514");
  
  // Attachment state
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  // Load settings from localStorage on mount
  useEffect(() => {
    const savedProvider = localStorage.getItem("easyhub_provider") as ProviderKey;
    const savedModel = localStorage.getItem("easyhub_default_model");
    if (savedProvider && PROVIDERS[savedProvider]) {
      setSelectedProvider(savedProvider);
    }
    if (savedModel) {
      setSelectedModel(savedModel);
    }
  }, []);

  // Get settings for API call
  const getSettings = useCallback((): ChatSettings => {
    const apiKeysStr = localStorage.getItem("easyhub_api_keys");
    const apiKeys = apiKeysStr ? JSON.parse(apiKeysStr) : {};
    const temperature = parseFloat(localStorage.getItem("easyhub_temperature") || "0.7");
    const maxTokens = parseInt(localStorage.getItem("easyhub_max_tokens") || "4096");
    const systemPrompt = localStorage.getItem("easyhub_system_prompt") || undefined;

    return {
      provider: selectedProvider,
      model: selectedModel,
      apiKey: apiKeys[selectedProvider] || "",
      temperature,
      maxTokens,
      systemPrompt,
    };
  }, [selectedProvider, selectedModel]);

  // Get current model name for display
  const getCurrentModelName = useCallback((): string => {
    const provider = PROVIDERS[selectedProvider];
    const model = provider?.models.find(m => m.id === selectedModel);
    return model?.name || selectedModel;
  }, [selectedProvider, selectedModel]);

  // Handle model change
  const handleModelChange = (provider: ProviderKey, model: string) => {
    setSelectedProvider(provider);
    setSelectedModel(model);
    // Also save to localStorage
    localStorage.setItem("easyhub_provider", provider);
    localStorage.setItem("easyhub_default_model", model);
  };

  // Load conversation when chatId changes
  useEffect(() => {
    if (chatId) {
      const conv = getConversation(chatId);
      if (conv) {
        setCurrentConversation(conv);
        setMessages(conv.messages || []);
      }
    } else {
      setCurrentConversation(null);
      setMessages([]);
    }
    setError(null);
    setStreamingContent("");
    setAttachments([]);
  }, [chatId]);

  // Auto-resize textarea
  const handleInput = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      const newHeight = Math.min(textarea.scrollHeight, 240);
      textarea.style.height = `${newHeight}px`;
    }
  };

  useEffect(() => {
    handleInput();
  }, [value]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  // Handle file attachment
  const handleAttachment = (files: FileList | null) => {
    if (!files) return;
    
    const newAttachments: Attachment[] = [];
    
    Array.from(files).forEach((file) => {
      const isImage = file.type.startsWith("image/");
      const attachment: Attachment = {
        id: generateId(),
        file,
        type: isImage ? "image" : "file",
      };
      
      if (isImage) {
        const reader = new FileReader();
        reader.onload = (e) => {
          attachment.preview = e.target?.result as string;
          setAttachments(prev => [...prev]);
        };
        reader.readAsDataURL(file);
      }
      
      newAttachments.push(attachment);
    });
    
    setAttachments(prev => [...prev, ...newAttachments]);
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  // Send message
  const handleSend = async () => {
    const content = value.trim();
    if ((!content && attachments.length === 0) || isLoading) return;

    setError(null);
    setValue("");
    
    const settings = getSettings();
    
    // Build message content with attachments info
    let messageContent = content;
    if (attachments.length > 0) {
      const attachmentInfo = attachments
        .map(a => `[Attached: ${a.file.name}]`)
        .join(" ");
      messageContent = attachmentInfo + (content ? "\n\n" + content : "");
    }
    
    // Create user message
    const userMessage: Message = {
      id: generateId(),
      role: "user",
      content: messageContent,
      timestamp: Date.now(),
    };

    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setIsLoading(true);
    setStreamingContent("");
    setAttachments([]);

    // Create or update conversation
    let conversation = currentConversation;
    if (!conversation) {
      conversation = {
        id: generateId(),
        title: generateTitle(content || attachments[0]?.file.name || "New chat"),
        messages: newMessages,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        provider: settings.provider,
        model: settings.model,
      };
      setCurrentConversation(conversation);
    } else {
      conversation = {
        ...conversation,
        messages: newMessages,
        updatedAt: Date.now(),
      };
    }

    saveConversation(conversation);
    onConversationUpdate?.();

    try {
      let fullResponse = "";

      await sendMessageStream(newMessages, settings, {
        onToken: (token) => {
          fullResponse += token;
          setStreamingContent(fullResponse);
        },
        onComplete: (response) => {
          const assistantMessage: Message = {
            id: generateId(),
            role: "assistant",
            content: response,
            timestamp: Date.now(),
            model: settings.model,
          };

          const updatedMessages = [...newMessages, assistantMessage];
          setMessages(updatedMessages);
          setStreamingContent("");
          setIsLoading(false);

          const updatedConversation = {
            ...conversation!,
            messages: updatedMessages,
            updatedAt: Date.now(),
          };
          setCurrentConversation(updatedConversation);
          saveConversation(updatedConversation);
          onConversationUpdate?.();
        },
        onError: (err) => {
          setError(err.message);
          setIsLoading(false);
          setStreamingContent("");
        },
      });
    } catch (err: any) {
      setError(err.message || "An error occurred");
      setIsLoading(false);
      setStreamingContent("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    setValue(suggestion);
    textareaRef.current?.focus();
  };

  const handleQuickAction = (prompt: string) => {
    setValue(prompt);
    textareaRef.current?.focus();
  };

  const hasMessages = messages.length > 0 || streamingContent;

  return (
    <div className="flex flex-col items-center w-full max-w-[720px] px-6 h-full">
      <AnimatePresence mode="wait">
        {!hasMessages ? (
          <motion.div
            key="welcome"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="flex flex-col items-center w-full"
          >
            <div className="text-center mb-10">
              <h1 
                className={`font-light text-[56px] tracking-tight mb-2 ${
                  isDark ? "text-white/90" : "text-black/80"
                }`}
                style={{ fontFamily: "Inter, sans-serif" }}
              >
                EasyHub
              </h1>
              <p className={`${isDark ? "text-gray-500" : "text-gray-400"} text-lg font-light`}>
                How can I help you today?
              </p>
            </div>

            <InputBox
              ref={textareaRef}
              value={value}
              onChange={setValue}
              onSend={handleSend}
              onKeyDown={handleKeyDown}
              isDark={isDark}
              isLoading={isLoading}
              selectedProvider={selectedProvider}
              selectedModel={selectedModel}
              onModelChange={handleModelChange}
              attachments={attachments}
              onAttachment={handleAttachment}
              onRemoveAttachment={removeAttachment}
            />

            <div className="w-full mt-10">
              <div className="flex flex-wrap justify-center gap-3">
                {QUICK_ACTIONS.map((action, idx) => (
                  <motion.button
                    key={action.label}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.4 + idx * 0.1 }}
                    whileHover={{ scale: 1.05, y: -2 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => handleQuickAction(action.prompt)}
                    className={`flex items-center gap-2 px-5 py-2 rounded-2xl text-[14px] font-medium border transition-all ${
                      isDark 
                        ? "border-white/5 text-gray-400 bg-white/[0.02] hover:border-[#2dd4bf]/30 hover:text-[#2dd4bf] hover:bg-[#2dd4bf]/5" 
                        : "border-gray-200 text-gray-600 bg-white hover:border-[#2dd4bf]/30 hover:text-[#0d9488] shadow-sm hover:shadow-md"
                    }`}
                  >
                    <action.icon size={16} />
                    {action.label}
                  </motion.button>
                ))}
              </div>
            </div>

            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1, duration: 1 }}
              className="mt-12 flex flex-col items-center gap-3"
            >
              <span className={`text-xs uppercase tracking-[0.2em] font-medium ${isDark ? "text-gray-600" : "text-gray-400"}`}>
                Try These
              </span>
              <div className="flex flex-col gap-2 w-full">
                {SUGGESTIONS.map((suggestion, idx) => (
                  <button 
                    key={idx}
                    onClick={() => handleSuggestionClick(suggestion)}
                    className={`text-sm text-left px-4 py-2 rounded-lg transition-colors ${
                      isDark ? "hover:bg-white/5 text-gray-500 hover:text-gray-300" : "hover:bg-black/5 text-gray-500 hover:text-gray-800"
                    }`}
                  >
                    "{suggestion}"
                  </button>
                ))}
              </div>
            </motion.div>
          </motion.div>
        ) : (
          <motion.div
            key="chat"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col w-full h-full min-h-[60vh]"
          >
            <div className="flex-1 overflow-y-auto py-6 space-y-6 mb-4">
              {messages.map((message) => (
                <MessageBubble key={message.id} message={message} isDark={isDark} />
              ))}
              
              {streamingContent && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex gap-4"
                >
                  <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                    isDark ? "bg-[#2dd4bf]/20" : "bg-[#2dd4bf]/10"
                  }`}>
                    <Bot size={18} className="text-[#2dd4bf]" />
                  </div>
                  <div className={`max-w-[80%] px-4 py-3 rounded-2xl rounded-bl-md text-[15px] leading-relaxed ${
                    isDark ? "bg-white/5 text-gray-200" : "bg-gray-100 text-gray-800"
                  }`}>
                    {renderContent(streamingContent, isDark)}
                    <span className="inline-block w-2 h-4 ml-1 bg-[#2dd4bf] animate-pulse rounded-sm" />
                  </div>
                </motion.div>
              )}

              {isLoading && !streamingContent && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex gap-4"
                >
                  <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                    isDark ? "bg-[#2dd4bf]/20" : "bg-[#2dd4bf]/10"
                  }`}>
                    <Loader2 size={18} className="text-[#2dd4bf] animate-spin" />
                  </div>
                  <div className={`px-4 py-3 rounded-2xl rounded-bl-md ${
                    isDark ? "bg-white/5" : "bg-gray-100"
                  }`}>
                    <div className="flex gap-1">
                      <span className="w-2 h-2 bg-[#2dd4bf] rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                      <span className="w-2 h-2 bg-[#2dd4bf] rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                      <span className="w-2 h-2 bg-[#2dd4bf] rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                  </div>
                </motion.div>
              )}

              {error && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex items-start gap-3 px-4 py-3 rounded-xl ${
                    isDark ? "bg-red-500/10 border border-red-500/20" : "bg-red-50 border border-red-200"
                  }`}
                >
                  <AlertCircle size={20} className="text-red-500 shrink-0 mt-0.5" />
                  <div>
                    <p className={`text-sm font-medium ${isDark ? "text-red-400" : "text-red-700"}`}>
                      Error
                    </p>
                    <p className={`text-sm mt-1 ${isDark ? "text-red-300/70" : "text-red-600"}`}>
                      {error}
                    </p>
                  </div>
                </motion.div>
              )}

              <div ref={messagesEndRef} />
            </div>

            <div className="shrink-0 pb-4">
              <InputBox
                ref={textareaRef}
                value={value}
                onChange={setValue}
                onSend={handleSend}
                onKeyDown={handleKeyDown}
                isDark={isDark}
                isLoading={isLoading}
                selectedProvider={selectedProvider}
                selectedModel={selectedModel}
                onModelChange={handleModelChange}
                attachments={attachments}
                onAttachment={handleAttachment}
                onRemoveAttachment={removeAttachment}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// Enhanced InputBox with model selector and file attachments
interface InputBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  isDark: boolean;
  isLoading: boolean;
  selectedProvider: ProviderKey;
  selectedModel: string;
  onModelChange: (provider: ProviderKey, model: string) => void;
  attachments: Attachment[];
  onAttachment: (files: FileList | null) => void;
  onRemoveAttachment: (id: string) => void;
}

const InputBox = React.forwardRef<HTMLTextAreaElement, InputBoxProps>(
  ({ value, onChange, onSend, onKeyDown, isDark, isLoading, selectedProvider, selectedModel, onModelChange, attachments, onAttachment, onRemoveAttachment }, ref) => {
    const [showModelSelector, setShowModelSelector] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const modelSelectorRef = useRef<HTMLDivElement>(null);

    // Close model selector when clicking outside
    useEffect(() => {
      const handleClickOutside = (e: MouseEvent) => {
        if (modelSelectorRef.current && !modelSelectorRef.current.contains(e.target as Node)) {
          setShowModelSelector(false);
        }
      };
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const currentProvider = PROVIDERS[selectedProvider];
    const currentModel = currentProvider?.models.find(m => m.id === selectedModel);
    const modelName = currentModel?.name || selectedModel;

    return (
      <motion.div 
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.2, duration: 0.5 }}
        className={`group relative w-full rounded-[28px] p-2 border transition-all duration-500 shadow-2xl ${
          isDark 
            ? "bg-[#161616]/80 backdrop-blur-xl border-white/10 focus-within:border-[#2dd4bf]/50 focus-within:ring-4 ring-[#2dd4bf]/5" 
            : "bg-white/80 backdrop-blur-xl border-gray-200 focus-within:border-[#2dd4bf]/50 focus-within:ring-4 ring-[#2dd4bf]/5"
        }`}
      >
        <div className="flex flex-col">
          {/* Attachments Preview */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-2">
              {attachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className={`relative group/attachment flex items-center gap-2 px-3 py-2 rounded-xl ${
                    isDark ? "bg-white/5" : "bg-gray-100"
                  }`}
                >
                  {attachment.type === "image" && attachment.preview ? (
                    <img 
                      src={attachment.preview} 
                      alt={attachment.file.name}
                      className="w-10 h-10 object-cover rounded-lg"
                    />
                  ) : (
                    <div className={`w-10 h-10 flex items-center justify-center rounded-lg ${
                      isDark ? "bg-white/10" : "bg-gray-200"
                    }`}>
                      <File size={20} className={isDark ? "text-gray-400" : "text-gray-500"} />
                    </div>
                  )}
                  <div className="flex flex-col">
                    <span className={`text-xs font-medium truncate max-w-[120px] ${
                      isDark ? "text-gray-300" : "text-gray-700"
                    }`}>
                      {attachment.file.name}
                    </span>
                    <span className={`text-xs ${isDark ? "text-gray-500" : "text-gray-400"}`}>
                      {(attachment.file.size / 1024).toFixed(1)} KB
                    </span>
                  </div>
                  <button
                    onClick={() => onRemoveAttachment(attachment.id)}
                    className={`absolute -top-1 -right-1 w-5 h-5 flex items-center justify-center rounded-full opacity-0 group-hover/attachment:opacity-100 transition-opacity ${
                      isDark ? "bg-red-500/80 text-white" : "bg-red-500 text-white"
                    }`}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask anything. Press Enter to send, Shift+Enter for new line."
            disabled={isLoading}
            className={`w-full bg-transparent outline-hidden resize-none min-h-[48px] px-4 pt-3 pb-2 text-[17px] leading-relaxed overflow-y-auto transition-colors ${
              isDark ? "text-gray-200 placeholder-gray-500" : "text-gray-800 placeholder-gray-400"
            } disabled:opacity-50`}
            rows={1}
          />
          
          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1">
              {/* File Attachment Button */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.txt,.md,.json,.csv,.doc,.docx"
                onChange={(e) => onAttachment(e.target.files)}
                className="hidden"
              />
              <button 
                onClick={() => fileInputRef.current?.click()}
                className={`p-2 rounded-full transition-colors ${
                  isDark ? "hover:bg-white/5 text-gray-500 hover:text-gray-300" : "hover:bg-black/5 text-gray-400 hover:text-gray-600"
                }`}
                title="Attach file"
              >
                <Paperclip size={20} />
              </button>
              
              <div className={`w-[1px] h-4 mx-1 ${isDark ? "bg-white/10" : "bg-black/10"}`} />
              
              {/* Model Selector */}
              <div className="relative" ref={modelSelectorRef}>
                <button 
                  onClick={() => setShowModelSelector(!showModelSelector)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-medium transition-all border ${
                    showModelSelector
                      ? isDark
                        ? "text-[#2dd4bf] border-[#2dd4bf]/30 bg-[#2dd4bf]/10"
                        : "text-[#0d9488] border-[#2dd4bf]/30 bg-[#2dd4bf]/10"
                      : isDark 
                        ? "text-gray-400 border-white/5 hover:border-white/20 hover:bg-white/5" 
                        : "text-gray-500 border-gray-200 hover:bg-gray-50"
                  }`}
                >
                  {modelName}
                  <ChevronDown size={14} className={`transition-transform ${showModelSelector ? "rotate-180" : ""}`} />
                </button>

                {/* Model Dropdown */}
                <AnimatePresence>
                  {showModelSelector && (
                    <motion.div
                      initial={{ opacity: 0, y: -10, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -10, scale: 0.95 }}
                      transition={{ duration: 0.15 }}
                      className={`absolute top-full left-0 mt-2 w-[320px] max-h-[400px] overflow-y-auto rounded-2xl border shadow-2xl z-50 ${
                        isDark ? "bg-[#1a1a1a] border-white/10" : "bg-white border-gray-200"
                      }`}
                    >
                      {(Object.keys(PROVIDERS) as ProviderKey[]).map((providerId) => {
                        const provider = PROVIDERS[providerId];
                        return (
                          <div key={providerId}>
                            <div className={`px-4 py-2 text-xs font-semibold uppercase tracking-wider sticky top-0 ${
                              isDark ? "bg-[#1a1a1a] text-gray-500 border-b border-white/5" : "bg-white text-gray-400 border-b border-gray-100"
                            }`}>
                              {provider.name}
                            </div>
                            {provider.models.map((model) => {
                              const isSelected = selectedProvider === providerId && selectedModel === model.id;
                              return (
                                <button
                                  key={model.id}
                                  onClick={() => {
                                    onModelChange(providerId, model.id);
                                    setShowModelSelector(false);
                                  }}
                                  className={`w-full flex items-center justify-between px-4 py-3 text-left transition-colors ${
                                    isSelected
                                      ? isDark
                                        ? "bg-[#2dd4bf]/10 text-[#2dd4bf]"
                                        : "bg-[#2dd4bf]/10 text-[#0d9488]"
                                      : isDark
                                        ? "hover:bg-white/5 text-gray-300"
                                        : "hover:bg-gray-50 text-gray-700"
                                  }`}
                                >
                                  <div>
                                    <div className="text-sm font-medium">{model.name}</div>
                                    <div className={`text-xs mt-0.5 ${
                                      isDark ? "text-gray-500" : "text-gray-400"
                                    }`}>
                                      {model.id}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className={`text-xs px-2 py-0.5 rounded-lg ${
                                      isDark ? "bg-white/5 text-gray-400" : "bg-gray-100 text-gray-500"
                                    }`}>
                                      {(model.context / 1000).toFixed(0)}K
                                    </span>
                                    {isSelected && (
                                      <Check size={16} className="text-[#2dd4bf]" />
                                    )}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        );
                      })}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            <motion.button 
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={onSend}
              disabled={(!value.trim() && attachments.length === 0) || isLoading}
              className={`w-10 h-10 flex items-center justify-center rounded-full transition-all shadow-lg ${
                (value.trim() || attachments.length > 0) && !isLoading
                  ? "bg-[#2dd4bf] text-black" 
                  : (isDark ? "bg-white/5 text-gray-600" : "bg-black/5 text-gray-300")
              } disabled:cursor-not-allowed`}
            >
              {isLoading ? (
                <Loader2 size={20} className="animate-spin" />
              ) : (
                <ArrowUp size={20} strokeWidth={3} />
              )}
            </motion.button>
          </div>
        </div>
      </motion.div>
    );
  }
);

InputBox.displayName = "InputBox";
