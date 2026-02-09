import React, { useState, useEffect } from "react";
import { X, MessageSquare, Wrench, Bell, Check, ExternalLink, Eye, EyeOff, ChevronRight, Globe, Bot, Smartphone, Calendar, Search, Monitor, MapPin, Camera } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface IntegrationsProps {
  isOpen: boolean;
  onClose: () => void;
  theme: "dark" | "light";
}

type TabType = "channels" | "tools" | "reminders";

// Channel definitions
const CHANNELS = [
  { 
    id: "telegram", 
    name: "Telegram", 
    icon: "🤖",
    description: "Connect via Bot API",
    configFields: [
      { key: "botToken", label: "Bot Token", type: "password", placeholder: "123456:ABC-DEF..." }
    ],
    docsUrl: "https://docs.openclaw.ai/channels/telegram"
  },
  { 
    id: "whatsapp", 
    name: "WhatsApp", 
    icon: "💬",
    description: "QR code pairing required",
    configFields: [],
    requiresPairing: true,
    docsUrl: "https://docs.openclaw.ai/channels/whatsapp"
  },
  { 
    id: "discord", 
    name: "Discord", 
    icon: "🎮",
    description: "Discord Bot API",
    configFields: [
      { key: "botToken", label: "Bot Token", type: "password", placeholder: "Your Discord bot token" },
      { key: "applicationId", label: "Application ID", type: "text", placeholder: "Application ID" }
    ],
    docsUrl: "https://docs.openclaw.ai/channels/discord"
  },
  { 
    id: "slack", 
    name: "Slack", 
    icon: "📱",
    description: "Slack workspace app",
    configFields: [
      { key: "botToken", label: "Bot Token", type: "password", placeholder: "xoxb-..." },
      { key: "appToken", label: "App Token", type: "password", placeholder: "xapp-..." }
    ],
    docsUrl: "https://docs.openclaw.ai/channels/slack"
  },
  { 
    id: "signal", 
    name: "Signal", 
    icon: "🔒",
    description: "Privacy-focused messaging",
    configFields: [
      { key: "phoneNumber", label: "Phone Number", type: "text", placeholder: "+1234567890" }
    ],
    docsUrl: "https://docs.openclaw.ai/channels/signal"
  },
  { 
    id: "imessage", 
    name: "iMessage", 
    icon: "🍎",
    description: "macOS only via BlueBubbles",
    configFields: [
      { key: "serverUrl", label: "Server URL", type: "text", placeholder: "http://localhost:1234" },
      { key: "password", label: "Password", type: "password", placeholder: "BlueBubbles password" }
    ],
    docsUrl: "https://docs.openclaw.ai/channels/bluebubbles"
  },
];

// Tool definitions
const TOOLS = [
  { 
    id: "web_search", 
    name: "Web Search", 
    icon: Search,
    description: "Search the web using Brave Search API",
    category: "web"
  },
  { 
    id: "web_fetch", 
    name: "Web Fetch", 
    icon: Globe,
    description: "Fetch and extract content from URLs",
    category: "web"
  },
  { 
    id: "browser", 
    name: "Browser Control", 
    icon: Monitor,
    description: "Automate web browser actions",
    category: "automation"
  },
  { 
    id: "nodes", 
    name: "Device Control", 
    icon: Smartphone,
    description: "Control paired mobile devices",
    category: "automation"
  },
  { 
    id: "camera", 
    name: "Camera", 
    icon: Camera,
    description: "Capture photos from paired devices",
    category: "automation"
  },
  { 
    id: "location", 
    name: "Location", 
    icon: MapPin,
    description: "Get location from paired devices",
    category: "automation"
  },
  { 
    id: "cron", 
    name: "Reminders & Cron", 
    icon: Calendar,
    description: "Schedule tasks and reminders",
    category: "scheduling"
  },
  { 
    id: "message", 
    name: "Messaging", 
    icon: MessageSquare,
    description: "Send messages across channels",
    category: "messaging"
  },
];

export const Integrations: React.FC<IntegrationsProps> = ({ isOpen, onClose, theme }) => {
  const isDark = theme === "dark";
  const [activeTab, setActiveTab] = useState<TabType>("channels");
  const [channelConfigs, setChannelConfigs] = useState<Record<string, any>>({});
  const [enabledChannels, setEnabledChannels] = useState<Record<string, boolean>>({});
  const [enabledTools, setEnabledTools] = useState<Record<string, boolean>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [expandedChannel, setExpandedChannel] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Load settings from localStorage
  useEffect(() => {
    const savedChannels = localStorage.getItem("easyhub_channels");
    const savedChannelConfigs = localStorage.getItem("easyhub_channel_configs");
    const savedTools = localStorage.getItem("easyhub_tools");
    
    if (savedChannels) setEnabledChannels(JSON.parse(savedChannels));
    if (savedChannelConfigs) setChannelConfigs(JSON.parse(savedChannelConfigs));
    if (savedTools) {
      setEnabledTools(JSON.parse(savedTools));
    } else {
      // Default: all tools enabled
      const defaultTools: Record<string, boolean> = {};
      TOOLS.forEach(t => defaultTools[t.id] = true);
      setEnabledTools(defaultTools);
    }
  }, []);

  const handleSave = () => {
    localStorage.setItem("easyhub_channels", JSON.stringify(enabledChannels));
    localStorage.setItem("easyhub_channel_configs", JSON.stringify(channelConfigs));
    localStorage.setItem("easyhub_tools", JSON.stringify(enabledTools));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const toggleChannel = (channelId: string) => {
    setEnabledChannels(prev => ({ ...prev, [channelId]: !prev[channelId] }));
  };

  const toggleTool = (toolId: string) => {
    setEnabledTools(prev => ({ ...prev, [toolId]: !prev[toolId] }));
  };

  const updateChannelConfig = (channelId: string, key: string, value: string) => {
    setChannelConfigs(prev => ({
      ...prev,
      [channelId]: { ...prev[channelId], [key]: value }
    }));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div 
        className={`absolute inset-0 ${isDark ? "bg-black/60" : "bg-black/40"} backdrop-blur-sm`}
        onClick={onClose}
      />
      
      <div 
        className={`relative w-full max-w-3xl mx-4 rounded-2xl border shadow-2xl max-h-[90vh] overflow-hidden flex flex-col ${
          isDark ? "bg-[#111] border-white/10" : "bg-white border-gray-200"
        }`}
      >
        {/* Header */}
        <div className={`flex items-center justify-between px-6 py-4 border-b shrink-0 ${
          isDark ? "border-white/10" : "border-gray-100"
        }`}>
          <h2 className={`text-lg font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>
            Integrations
          </h2>
          <button
            onClick={onClose}
            className={`p-2 rounded-lg transition-colors ${
              isDark ? "hover:bg-white/10 text-gray-400" : "hover:bg-gray-100 text-gray-500"
            }`}
          >
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className={`flex border-b px-6 ${isDark ? "border-white/10" : "border-gray-100"}`}>
          {[
            { id: "channels" as TabType, label: "Channels", icon: MessageSquare },
            { id: "tools" as TabType, label: "Tools", icon: Wrench },
            { id: "reminders" as TabType, label: "Reminders", icon: Bell },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-[#2dd4bf] text-[#2dd4bf]"
                  : isDark
                    ? "border-transparent text-gray-500 hover:text-gray-300"
                    : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              <tab.icon size={16} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1">
          {activeTab === "channels" && (
            <div className="space-y-3">
              <p className={`text-sm mb-4 ${isDark ? "text-gray-400" : "text-gray-600"}`}>
                Connect EasyHub to your favorite messaging platforms.
              </p>
              
              {CHANNELS.map((channel) => {
                const isEnabled = enabledChannels[channel.id];
                const isExpanded = expandedChannel === channel.id;
                const config = channelConfigs[channel.id] || {};
                
                return (
                  <div
                    key={channel.id}
                    className={`rounded-xl border transition-all ${
                      isEnabled
                        ? isDark
                          ? "border-[#2dd4bf]/30 bg-[#2dd4bf]/5"
                          : "border-[#2dd4bf]/50 bg-[#2dd4bf]/5"
                        : isDark
                          ? "border-white/10"
                          : "border-gray-200"
                    }`}
                  >
                    <div 
                      className="flex items-center justify-between p-4 cursor-pointer"
                      onClick={() => setExpandedChannel(isExpanded ? null : channel.id)}
                    >
                      <div className="flex items-center gap-4">
                        <span className="text-2xl">{channel.icon}</span>
                        <div>
                          <div className={`font-medium ${isDark ? "text-white" : "text-gray-900"}`}>
                            {channel.name}
                          </div>
                          <div className={`text-sm ${isDark ? "text-gray-500" : "text-gray-500"}`}>
                            {channel.description}
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-3">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleChannel(channel.id);
                          }}
                          className={`relative w-12 h-6 rounded-full transition-colors ${
                            isEnabled ? "bg-[#2dd4bf]" : isDark ? "bg-white/10" : "bg-gray-200"
                          }`}
                        >
                          <div 
                            className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                              isEnabled ? "translate-x-7" : "translate-x-1"
                            }`}
                          />
                        </button>
                        <ChevronRight 
                          size={20} 
                          className={`transition-transform ${isDark ? "text-gray-500" : "text-gray-400"} ${
                            isExpanded ? "rotate-90" : ""
                          }`}
                        />
                      </div>
                    </div>
                    
                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="overflow-hidden"
                        >
                          <div className={`px-4 pb-4 pt-2 border-t ${
                            isDark ? "border-white/5" : "border-gray-100"
                          }`}>
                            {channel.requiresPairing ? (
                              <div className={`text-sm ${isDark ? "text-gray-400" : "text-gray-600"}`}>
                                <p className="mb-3">This channel requires QR code pairing through the gateway.</p>
                                <code className={`block p-3 rounded-lg text-xs font-mono ${
                                  isDark ? "bg-black/30" : "bg-gray-100"
                                }`}>
                                  openclaw gateway
                                </code>
                              </div>
                            ) : channel.configFields.length > 0 ? (
                              <div className="space-y-3">
                                {channel.configFields.map((field) => (
                                  <div key={field.key}>
                                    <label className={`block text-sm font-medium mb-1.5 ${
                                      isDark ? "text-gray-300" : "text-gray-700"
                                    }`}>
                                      {field.label}
                                    </label>
                                    <div className="relative">
                                      <input
                                        type={field.type === "password" && !showSecrets[`${channel.id}_${field.key}`] ? "password" : "text"}
                                        value={config[field.key] || ""}
                                        onChange={(e) => updateChannelConfig(channel.id, field.key, e.target.value)}
                                        placeholder={field.placeholder}
                                        className={`w-full px-3 py-2 pr-10 rounded-lg border text-sm font-mono ${
                                          isDark
                                            ? "bg-black/30 border-white/10 text-white placeholder-gray-500"
                                            : "bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400"
                                        } outline-none focus:border-[#2dd4bf]/50`}
                                      />
                                      {field.type === "password" && (
                                        <button
                                          onClick={() => setShowSecrets(prev => ({
                                            ...prev,
                                            [`${channel.id}_${field.key}`]: !prev[`${channel.id}_${field.key}`]
                                          }))}
                                          className={`absolute right-2 top-1/2 -translate-y-1/2 p-1 ${
                                            isDark ? "text-gray-500" : "text-gray-400"
                                          }`}
                                        >
                                          {showSecrets[`${channel.id}_${field.key}`] ? <EyeOff size={16} /> : <Eye size={16} />}
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                            
                            <a
                              href={channel.docsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`inline-flex items-center gap-1 mt-3 text-xs ${
                                isDark ? "text-[#2dd4bf]" : "text-[#0d9488]"
                              } hover:underline`}
                            >
                              View documentation
                              <ExternalLink size={12} />
                            </a>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          )}

          {activeTab === "tools" && (
            <div className="space-y-4">
              <p className={`text-sm mb-4 ${isDark ? "text-gray-400" : "text-gray-600"}`}>
                Enable or disable AI tools and capabilities.
              </p>
              
              {["web", "automation", "scheduling", "messaging"].map((category) => {
                const categoryTools = TOOLS.filter(t => t.category === category);
                const categoryLabels: Record<string, string> = {
                  web: "Web & Search",
                  automation: "Automation",
                  scheduling: "Scheduling",
                  messaging: "Messaging"
                };
                
                return (
                  <div key={category}>
                    <h3 className={`text-xs font-semibold uppercase tracking-wider mb-3 ${
                      isDark ? "text-gray-500" : "text-gray-400"
                    }`}>
                      {categoryLabels[category]}
                    </h3>
                    <div className="grid gap-2">
                      {categoryTools.map((tool) => {
                        const isEnabled = enabledTools[tool.id] !== false;
                        const Icon = tool.icon;
                        
                        return (
                          <div
                            key={tool.id}
                            onClick={() => toggleTool(tool.id)}
                            className={`flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all ${
                              isEnabled
                                ? isDark
                                  ? "border-[#2dd4bf]/30 bg-[#2dd4bf]/5"
                                  : "border-[#2dd4bf]/50 bg-[#2dd4bf]/5"
                                : isDark
                                  ? "border-white/10 opacity-60"
                                  : "border-gray-200 opacity-60"
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              <div className={`p-2 rounded-lg ${
                                isEnabled
                                  ? "bg-[#2dd4bf]/20 text-[#2dd4bf]"
                                  : isDark
                                    ? "bg-white/5 text-gray-500"
                                    : "bg-gray-100 text-gray-400"
                              }`}>
                                <Icon size={18} />
                              </div>
                              <div>
                                <div className={`font-medium text-sm ${
                                  isDark ? "text-white" : "text-gray-900"
                                }`}>
                                  {tool.name}
                                </div>
                                <div className={`text-xs ${
                                  isDark ? "text-gray-500" : "text-gray-500"
                                }`}>
                                  {tool.description}
                                </div>
                              </div>
                            </div>
                            
                            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                              isEnabled
                                ? "border-[#2dd4bf] bg-[#2dd4bf]"
                                : isDark
                                  ? "border-white/20"
                                  : "border-gray-300"
                            }`}>
                              {isEnabled && <Check size={12} className="text-black" />}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {activeTab === "reminders" && (
            <div className="space-y-4">
              <p className={`text-sm mb-4 ${isDark ? "text-gray-400" : "text-gray-600"}`}>
                Schedule reminders and recurring tasks.
              </p>
              
              <div className={`p-6 rounded-xl border text-center ${
                isDark ? "border-white/10 bg-white/5" : "border-gray-200 bg-gray-50"
              }`}>
                <Calendar size={40} className={`mx-auto mb-3 ${
                  isDark ? "text-gray-500" : "text-gray-400"
                }`} />
                <h3 className={`font-medium mb-2 ${isDark ? "text-white" : "text-gray-900"}`}>
                  Coming Soon
                </h3>
                <p className={`text-sm ${isDark ? "text-gray-500" : "text-gray-500"}`}>
                  Manage your reminders and scheduled tasks here.
                </p>
                <p className={`text-xs mt-3 ${isDark ? "text-gray-600" : "text-gray-400"}`}>
                  For now, use chat commands like "remind me in 30 minutes to..."
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`flex items-center justify-end gap-3 px-6 py-4 border-t shrink-0 ${
          isDark ? "border-white/10" : "border-gray-100"
        }`}>
          <button
            onClick={onClose}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
              isDark
                ? "text-gray-400 hover:bg-white/5"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-2 ${
              saved
                ? "bg-green-500 text-white"
                : "bg-[#2dd4bf] text-black hover:bg-[#5eead4]"
            }`}
          >
            {saved ? (
              <>
                <Check size={16} />
                Saved!
              </>
            ) : (
              "Save Changes"
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
