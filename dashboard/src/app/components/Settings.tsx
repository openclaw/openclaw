import React, { useState, useEffect } from "react";
import { X, Eye, EyeOff, Check, RefreshCw, Link2, AlertCircle, Info } from "lucide-react";
import { PROVIDERS, type ProviderKey, buildModelString, parseModelString, checkGatewayStatus, setGatewayToken } from "../lib/easyhub";

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  theme: "dark" | "light";
}

type TabType = "models" | "advanced" | "EasyHub";

export const Settings: React.FC<SettingsProps> = ({ isOpen, onClose, theme }) => {
  const isDark = theme === "dark";
  
  const [activeTab, setActiveTab] = useState<TabType>("models");
  const [activeProvider, setActiveProvider] = useState<ProviderKey>("anthropic");
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [selectedModel, setSelectedModel] = useState("claude-sonnet-4-20250514");
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState(false);
  
  // Advanced settings
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(4096);
  const [systemPrompt, setSystemPrompt] = useState("");

  // EasyHub integration
  const [gatewayToken, setGatewayTokenState] = useState("");
  const [gatewayStatus, setGatewayStatus] = useState<{ connected: boolean; error?: string } | null>(null);
  const [checkingGateway, setCheckingGateway] = useState(false);

  // Load settings from localStorage
  useEffect(() => {
    const savedKeys = localStorage.getItem("easyhub_api_keys");
    const savedModel = localStorage.getItem("easyhub_default_model");
    const savedProvider = localStorage.getItem("easyhub_provider");
    const savedTemp = localStorage.getItem("easyhub_temperature");
    const savedMaxTokens = localStorage.getItem("easyhub_max_tokens");
    const savedSystemPrompt = localStorage.getItem("easyhub_system_prompt");
    const savedGatewayToken = localStorage.getItem("easyhub_gateway_token");
    
    if (savedKeys) setApiKeys(JSON.parse(savedKeys));
    if (savedModel) setSelectedModel(savedModel);
    if (savedProvider) setActiveProvider(savedProvider as ProviderKey);
    if (savedTemp) setTemperature(parseFloat(savedTemp));
    if (savedMaxTokens) setMaxTokens(parseInt(savedMaxTokens));
    if (savedSystemPrompt) setSystemPrompt(savedSystemPrompt);
    if (savedGatewayToken) setGatewayTokenState(savedGatewayToken);
  }, []);

  // Check gateway status on mount and when token changes
  useEffect(() => {
    if (isOpen) {
      handleCheckGateway();
    }
  }, [isOpen]);

  const handleCheckGateway = async () => {
    setCheckingGateway(true);
    const status = await checkGatewayStatus();
    setGatewayStatus(status);
    setCheckingGateway(false);
  };

  const handleSave = () => {
    localStorage.setItem("easyhub_api_keys", JSON.stringify(apiKeys));
    localStorage.setItem("easyhub_default_model", selectedModel);
    localStorage.setItem("easyhub_provider", activeProvider);
    localStorage.setItem("easyhub_temperature", temperature.toString());
    localStorage.setItem("easyhub_max_tokens", maxTokens.toString());
    localStorage.setItem("easyhub_system_prompt", systemPrompt);
    
    if (gatewayToken) {
      setGatewayToken(gatewayToken);
    }
    
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleApiKeyChange = (providerId: string, value: string) => {
    setApiKeys((prev) => ({ ...prev, [providerId]: value }));
  };

  const toggleShowApiKey = (providerId: string) => {
    setShowApiKey((prev) => ({ ...prev, [providerId]: !prev[providerId] }));
  };

  const handleProviderChange = (provider: ProviderKey) => {
    setActiveProvider(provider);
    // Set first model of provider as default
    const firstModel = PROVIDERS[provider].models[0];
    if (firstModel) {
      setSelectedModel(firstModel.id);
    }
  };

  const currentProvider = PROVIDERS[activeProvider];
  const fullModelString = buildModelString(activeProvider, selectedModel);

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
        className={`relative w-full max-w-2xl mx-4 rounded-2xl border shadow-2xl max-h-[90vh] overflow-hidden flex flex-col ${
          isDark ? "bg-[#111] border-white/10" : "bg-white border-gray-200"
        }`}
      >
        {/* Header */}
        <div className={`flex items-center justify-between px-6 py-4 border-b shrink-0 ${
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

        {/* Tabs */}
        <div className={`flex border-b px-6 ${isDark ? "border-white/10" : "border-gray-100"}`}>
          {[
            { id: "models" as TabType, label: "Models" },
            { id: "advanced" as TabType, label: "Advanced" },
            { id: "EasyHub" as TabType, label: "Gateway" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-[#2dd4bf] text-[#2dd4bf]"
                  : isDark
                    ? "border-transparent text-gray-500 hover:text-gray-300"
                    : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 overflow-y-auto flex-1">
          {activeTab === "models" && (
            <>
              {/* Provider Selection */}
              <div>
                <label className={`block text-sm font-medium mb-3 ${
                  isDark ? "text-gray-300" : "text-gray-700"
                }`}>
                  AI Provider
                </label>
                <div className="flex flex-wrap gap-2">
                  {(Object.keys(PROVIDERS) as ProviderKey[]).map((provider) => (
                    <button
                      key={provider}
                      onClick={() => handleProviderChange(provider)}
                      className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                        activeProvider === provider
                          ? "bg-[#2dd4bf] text-black"
                          : isDark
                            ? "bg-white/5 text-gray-400 hover:bg-white/10"
                            : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                      }`}
                    >
                      {PROVIDERS[provider].name}
                    </button>
                  ))}
                </div>
              </div>

              {/* API Key */}
              <div>
                <label className={`block text-sm font-medium mb-3 ${
                  isDark ? "text-gray-300" : "text-gray-700"
                }`}>
                  API Key for {currentProvider.name}
                </label>
                <div className="relative">
                  <input
                    type={showApiKey[activeProvider] ? "text" : "password"}
                    value={apiKeys[activeProvider] || ""}
                    onChange={(e) => handleApiKeyChange(activeProvider, e.target.value)}
                    placeholder={`Enter your ${currentProvider.name} API key`}
                    className={`w-full px-4 py-3 pr-12 rounded-xl border text-sm transition-colors font-mono ${
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
                  Model
                </label>
                <div className="grid gap-2">
                  {currentProvider.models.map((model) => (
                    <button
                      key={model.id}
                      onClick={() => setSelectedModel(model.id)}
                      className={`flex items-center justify-between p-3 rounded-xl border text-left transition-all ${
                        selectedModel === model.id
                          ? isDark
                            ? "border-[#2dd4bf]/50 bg-[#2dd4bf]/10"
                            : "border-[#2dd4bf] bg-[#2dd4bf]/5"
                          : isDark
                            ? "border-white/10 hover:border-white/20"
                            : "border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      <div>
                        <div className={`font-medium text-sm ${
                          isDark ? "text-white" : "text-gray-900"
                        }`}>
                          {model.name}
                        </div>
                        <div className={`text-xs mt-0.5 ${
                          isDark ? "text-gray-500" : "text-gray-400"
                        }`}>
                          {model.id}
                        </div>
                      </div>
                      <div className={`text-xs px-2 py-1 rounded-lg ${
                        isDark ? "bg-white/5 text-gray-400" : "bg-gray-100 text-gray-500"
                      }`}>
                        {(model.context / 1000).toFixed(0)}K
                      </div>
                    </button>
                  ))}
                </div>
                
                {/* Full model string display */}
                <div className={`mt-3 p-3 rounded-lg ${
                  isDark ? "bg-white/5" : "bg-gray-50"
                }`}>
                  <div className={`text-xs font-medium mb-1 ${
                    isDark ? "text-gray-400" : "text-gray-500"
                  }`}>
                    Model ID
                  </div>
                  <code className={`text-sm font-mono ${
                    isDark ? "text-[#2dd4bf]" : "text-[#0d9488]"
                  }`}>
                    {fullModelString}
                  </code>
                </div>
              </div>
            </>
          )}

          {activeTab === "advanced" && (
            <>
              {/* Temperature */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <label className={`text-sm font-medium ${isDark ? "text-gray-300" : "text-gray-700"}`}>
                    Temperature
                  </label>
                  <span className={`text-sm font-mono ${isDark ? "text-gray-400" : "text-gray-500"}`}>
                    {temperature.toFixed(1)}
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                  className="w-full h-2 rounded-full appearance-none cursor-pointer accent-[#2dd4bf]"
                  style={{
                    background: isDark 
                      ? `linear-gradient(to right, #2dd4bf ${temperature * 50}%, #333 ${temperature * 50}%)`
                      : `linear-gradient(to right, #2dd4bf ${temperature * 50}%, #e5e7eb ${temperature * 50}%)`
                  }}
                />
                <div className={`flex justify-between text-xs mt-1 ${isDark ? "text-gray-500" : "text-gray-400"}`}>
                  <span>Precise (0)</span>
                  <span>Creative (2)</span>
                </div>
              </div>

              {/* Max Tokens */}
              <div>
                <label className={`block text-sm font-medium mb-3 ${
                  isDark ? "text-gray-300" : "text-gray-700"
                }`}>
                  Max Output Tokens
                </label>
                <input
                  type="number"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(parseInt(e.target.value) || 0)}
                  min="1"
                  max="128000"
                  className={`w-full px-4 py-3 rounded-xl border text-sm transition-colors ${
                    isDark
                      ? "bg-white/5 border-white/10 text-white focus:border-[#2dd4bf]/50"
                      : "bg-gray-50 border-gray-200 text-gray-900 focus:border-[#2dd4bf]"
                  } outline-none`}
                />
              </div>

              {/* System Prompt */}
              <div>
                <label className={`block text-sm font-medium mb-3 ${
                  isDark ? "text-gray-300" : "text-gray-700"
                }`}>
                  System Prompt (Optional)
                </label>
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="Enter a custom system prompt to set the AI's behavior..."
                  rows={4}
                  className={`w-full px-4 py-3 rounded-xl border text-sm transition-colors resize-none ${
                    isDark
                      ? "bg-white/5 border-white/10 text-white placeholder-gray-500 focus:border-[#2dd4bf]/50"
                      : "bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-[#2dd4bf]"
                  } outline-none`}
                />
              </div>
            </>
          )}

          {activeTab === "EasyHub" && (
            <>
              {/* Gateway Status */}
              <div className={`p-4 rounded-xl border ${
                gatewayStatus?.connected
                  ? isDark ? "border-green-500/30 bg-green-500/10" : "border-green-200 bg-green-50"
                  : isDark ? "border-yellow-500/30 bg-yellow-500/10" : "border-yellow-200 bg-yellow-50"
              }`}>
                <div className="flex items-start gap-3">
                  {gatewayStatus?.connected ? (
                    <Check size={20} className="text-green-500 mt-0.5" />
                  ) : (
                    <AlertCircle size={20} className={`mt-0.5 ${
                      isDark ? "text-yellow-400" : "text-yellow-600"
                    }`} />
                  )}
                  <div className="flex-1">
                    <div className={`font-medium text-sm ${
                      gatewayStatus?.connected
                        ? isDark ? "text-green-400" : "text-green-700"
                        : isDark ? "text-yellow-400" : "text-yellow-700"
                    }`}>
                      {gatewayStatus?.connected ? "Gateway Connected" : "Gateway Not Connected"}
                    </div>
                    <div className={`text-xs mt-1 ${
                      isDark ? "text-gray-400" : "text-gray-600"
                    }`}>
                      {gatewayStatus?.connected 
                        ? "Gateway is running on localhost:18789"
                        : gatewayStatus?.error || "Start the gateway to enable sync"
                      }
                    </div>
                  </div>
                  <button
                    onClick={handleCheckGateway}
                    disabled={checkingGateway}
                    className={`p-2 rounded-lg transition-colors ${
                      isDark ? "hover:bg-white/10 text-gray-400" : "hover:bg-gray-200 text-gray-500"
                    }`}
                  >
                    <RefreshCw size={16} className={checkingGateway ? "animate-spin" : ""} />
                  </button>
                </div>
              </div>

              {/* Gateway Token */}
              <div>
                <label className={`block text-sm font-medium mb-3 ${
                  isDark ? "text-gray-300" : "text-gray-700"
                }`}>
                  Gateway Auth Token
                </label>
                <input
                  type="password"
                  value={gatewayToken}
                  onChange={(e) => setGatewayTokenState(e.target.value)}
                  placeholder="Enter your gateway auth token"
                  className={`w-full px-4 py-3 rounded-xl border text-sm transition-colors font-mono ${
                    isDark
                      ? "bg-white/5 border-white/10 text-white placeholder-gray-500 focus:border-[#2dd4bf]/50"
                      : "bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-[#2dd4bf]"
                  } outline-none`}
                />
                <p className={`mt-2 text-xs ${isDark ? "text-gray-500" : "text-gray-400"}`}>
                  Required to connect to the gateway for settings sync
                </p>
              </div>

              {/* Info about integration */}
              <div className={`p-4 rounded-xl ${
                isDark ? "bg-white/5" : "bg-gray-50"
              }`}>
                <div className="flex items-start gap-3">
                  <Info size={18} className={isDark ? "text-gray-400" : "text-gray-500"} />
                  <div>
                    <div className={`font-medium text-sm mb-2 ${
                      isDark ? "text-white" : "text-gray-900"
                    }`}>
                      Gateway Integration
                    </div>
                    <div className={`text-xs space-y-2 ${
                      isDark ? "text-gray-400" : "text-gray-600"
                    }`}>
                      <p>
                        When connected, EasyHub can sync settings with your gateway:
                      </p>
                      <ul className="list-disc list-inside space-y-1 ml-2">
                        <li>Model selection synced automatically</li>
                        <li>API keys managed through the auth system</li>
                        <li>Chat messages routed through the gateway</li>
                      </ul>
                      <p className="mt-2">
                        <strong>Coming soon:</strong> Full two-way configuration sync.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className={`flex items-center justify-between px-6 py-4 border-t shrink-0 ${
          isDark ? "border-white/10" : "border-gray-100"
        }`}>
          <div className={`text-xs ${isDark ? "text-gray-500" : "text-gray-400"}`}>
            Model: <code className="font-mono">{fullModelString}</code>
          </div>
          <div className="flex items-center gap-3">
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
    </div>
  );
};
