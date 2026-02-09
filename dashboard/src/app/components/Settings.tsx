import React, { useState, useEffect } from "react";
import { X, Eye, EyeOff, Check, Plus, Trash2 } from "lucide-react";

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  theme: "dark" | "light";
}

interface AIProvider {
  id: string;
  name: string;
  models: { id: string; name: string }[];
}

const AI_PROVIDERS: AIProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    models: [
      { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet" },
      { id: "claude-3-opus-20240229", name: "Claude 3 Opus" },
      { id: "claude-3-haiku-20240307", name: "Claude 3 Haiku" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "gpt-4-turbo", name: "GPT-4 Turbo" },
      { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
    ],
  },
  {
    id: "google",
    name: "Google",
    models: [
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro" },
      { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash" },
    ],
  },
];

export const Settings: React.FC<SettingsProps> = ({ isOpen, onClose, theme }) => {
  const isDark = theme === "dark";
  
  const [activeProvider, setActiveProvider] = useState("anthropic");
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [defaultModel, setDefaultModel] = useState("claude-3-5-sonnet-20241022");
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState(false);

  // Load settings from localStorage
  useEffect(() => {
    const savedKeys = localStorage.getItem("easyhub_api_keys");
    const savedModel = localStorage.getItem("easyhub_default_model");
    const savedProvider = localStorage.getItem("easyhub_provider");
    
    if (savedKeys) setApiKeys(JSON.parse(savedKeys));
    if (savedModel) setDefaultModel(savedModel);
    if (savedProvider) setActiveProvider(savedProvider);
  }, []);

  const handleSave = () => {
    localStorage.setItem("easyhub_api_keys", JSON.stringify(apiKeys));
    localStorage.setItem("easyhub_default_model", defaultModel);
    localStorage.setItem("easyhub_provider", activeProvider);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleApiKeyChange = (providerId: string, value: string) => {
    setApiKeys((prev) => ({ ...prev, [providerId]: value }));
  };

  const toggleShowApiKey = (providerId: string) => {
    setShowApiKey((prev) => ({ ...prev, [providerId]: !prev[providerId] }));
  };

  const currentProvider = AI_PROVIDERS.find((p) => p.id === activeProvider);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className={`absolute inset-0 ${isDark ? "bg-black/60" : "bg-black/40"} backdrop-blur-sm`}
        onClick={onClose}
      />
      
      {/* Modal */}
      <div 
        className={`relative w-full max-w-lg mx-4 rounded-2xl border shadow-2xl ${
          isDark ? "bg-[#111] border-white/10" : "bg-white border-gray-200"
        }`}
      >
        {/* Header */}
        <div className={`flex items-center justify-between px-6 py-4 border-b ${
          isDark ? "border-white/10" : "border-gray-100"
        }`}>
          <h2 className={`text-lg font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>
            Settings
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

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Provider Selection */}
          <div>
            <label className={`block text-sm font-medium mb-3 ${
              isDark ? "text-gray-300" : "text-gray-700"
            }`}>
              AI Provider
            </label>
            <div className="flex flex-wrap gap-2">
              {AI_PROVIDERS.map((provider) => (
                <button
                  key={provider.id}
                  onClick={() => {
                    setActiveProvider(provider.id);
                    setDefaultModel(provider.models[0].id);
                  }}
                  className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                    activeProvider === provider.id
                      ? "bg-[#2dd4bf] text-black"
                      : isDark
                        ? "bg-white/5 text-gray-400 hover:bg-white/10"
                        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {provider.name}
                </button>
              ))}
            </div>
          </div>

          {/* API Key */}
          <div>
            <label className={`block text-sm font-medium mb-3 ${
              isDark ? "text-gray-300" : "text-gray-700"
            }`}>
              API Key for {currentProvider?.name}
            </label>
            <div className="relative">
              <input
                type={showApiKey[activeProvider] ? "text" : "password"}
                value={apiKeys[activeProvider] || ""}
                onChange={(e) => handleApiKeyChange(activeProvider, e.target.value)}
                placeholder={`Enter your ${currentProvider?.name} API key`}
                className={`w-full px-4 py-3 pr-12 rounded-xl border text-sm transition-colors ${
                  isDark
                    ? "bg-white/5 border-white/10 text-white placeholder-gray-500 focus:border-[#2dd4bf]/50"
                    : "bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-[#2dd4bf]"
                } outline-none`}
              />
              <button
                onClick={() => toggleShowApiKey(activeProvider)}
                className={`absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded ${
                  isDark ? "text-gray-500 hover:text-gray-300" : "text-gray-400 hover:text-gray-600"
                }`}
              >
                {showApiKey[activeProvider] ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <p className={`mt-2 text-xs ${isDark ? "text-gray-500" : "text-gray-400"}`}>
              Your API key is stored locally and never sent to our servers.
            </p>
          </div>

          {/* Model Selection */}
          <div>
            <label className={`block text-sm font-medium mb-3 ${
              isDark ? "text-gray-300" : "text-gray-700"
            }`}>
              Default Model
            </label>
            <select
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              className={`w-full px-4 py-3 rounded-xl border text-sm transition-colors appearance-none cursor-pointer ${
                isDark
                  ? "bg-white/5 border-white/10 text-white focus:border-[#2dd4bf]/50"
                  : "bg-gray-50 border-gray-200 text-gray-900 focus:border-[#2dd4bf]"
              } outline-none`}
            >
              {currentProvider?.models.map((model) => (
                <option key={model.id} value={model.id} className={isDark ? "bg-[#111]" : ""}>
                  {model.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Footer */}
        <div className={`flex items-center justify-end gap-3 px-6 py-4 border-t ${
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
