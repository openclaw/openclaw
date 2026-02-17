"use client";

import { useState, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types (mirroring /api/settings/providers response)
// ---------------------------------------------------------------------------
type AuthMethod = {
  value: string;
  label: string;
  hint?: string;
  type: "api-key" | "oauth" | "token" | "device-flow" | "unsupported";
  defaultModel?: string;
};

type ProviderGroup = {
  value: string;
  label: string;
  hint?: string;
  methods: AuthMethod[];
};

// ---------------------------------------------------------------------------
// Icons (inline SVG for zero-dependency)
// ---------------------------------------------------------------------------
function ChevronRight({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function CheckCircle({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function KeyIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}

function ServerIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
      <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
      <line x1="6" x2="6.01" y1="6" y2="6" />
      <line x1="6" x2="6.01" y1="18" y2="18" />
    </svg>
  );
}

function SparklesIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
      <path d="M5 3v4" />
      <path d="M19 17v4" />
      <path d="M3 5h4" />
      <path d="M17 19h4" />
    </svg>
  );
}

function EyeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  );
}

function ArrowLeftIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  );
}

function ExternalLinkIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" x2="21" y1="14" y2="3" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// SettingsView Component
// ---------------------------------------------------------------------------
type AuthProfileSummary = {
  profileId: string;
  provider: string;
  type: string;
  hasKey: boolean;
};

export function SettingsView() {
  // State
  const [providers, setProviders] = useState<ProviderGroup[]>([]);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [currentConfig, setCurrentConfig] = useState<Record<string, unknown> | null>(null);
  const [authProfiles, setAuthProfiles] = useState<AuthProfileSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // Wizard state
  const [selectedProvider, setSelectedProvider] = useState<ProviderGroup | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<AuthMethod | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [tokenName, setTokenName] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; message: string } | null>(null);

  // OAuth state
  const [oauthPending, setOauthPending] = useState(false);
  const [oauthWindow, setOauthWindow] = useState<Window | null>(null);

  // Device Flow state (GitHub Copilot)
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState<string | null>(null);
  const [devicePollInterval, setDevicePollInterval] = useState<NodeJS.Timeout | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [providersRes, modelRes, configRes] = await Promise.all([
        fetch("/api/settings/providers"),
        fetch("/api/settings/model"),
        fetch("/api/settings/config"),
      ]);
      const providersData = await providersRes.json();
      const modelData = await modelRes.json();
      const configData = await configRes.json();

      setProviders(providersData.providers ?? []);
      setCurrentModel(modelData.model ?? null);
      setCurrentConfig(configData.config ?? null);
      setAuthProfiles(configData.authProfiles ?? []);
    } catch (err) {
      console.error("Failed to load settings:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Cleanup timers
  useEffect(() => {
    return () => {
      if (devicePollInterval) {clearInterval(devicePollInterval);}
    };
  }, [devicePollInterval]);

  // OAuth postMessage listener
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "oauth_complete") {
        setOauthPending(false);
        setSaveResult({ ok: true, message: `Successfully connected ${event.data.provider}!` });
        fetchData();
        // Auto-advance or reset after delay
        setTimeout(() => {
          setSelectedProvider(null);
          setSelectedMethod(null);
          setSaveResult(null);
        }, 2000);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [fetchData]);

  // Auth/Save handler
  const handleSave = async () => {
    if (!selectedMethod) {return;}
    setSaving(true);
    setSaveResult(null);

    try {
      // 1) Save auth (API Key or Token)
      const endpoint = selectedMethod.type === "token" ? "/api/settings/token" : "/api/settings/auth";
      const payload = selectedMethod.type === "token" 
        ? {
            provider: selectedProvider?.value,
            authMethod: selectedMethod.value,
            token: tokenInput,
            name: tokenName,
          }
        : {
            provider: selectedProvider?.value,
            authMethod: selectedMethod.value,
            apiKey: apiKeyInput,
          };

      const authRes = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const authData = await authRes.json();
      if (!authRes.ok) {throw new Error(authData.error);}

      // 2) Save model if specified
      const finalModel = modelInput.trim() || selectedMethod.defaultModel;
      if (finalModel) {
        const modelRes = await fetch("/api/settings/model", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: finalModel }),
        });
        const modelData = await modelRes.json();
        if (!modelRes.ok) {throw new Error(modelData.error);}
        setCurrentModel(finalModel);
      }

      setSaveResult({ ok: true, message: "Configuration saved successfully!" });
      setTimeout(() => {
        resetWizard();
        fetchData();
      }, 2000);
    } catch (err) {
      setSaveResult({ ok: false, message: String(err) });
    } finally {
      setSaving(false);
    }
  };

  // OAuth Connect
  const handleConnectOAuth = async () => {
    if (!selectedProvider) {return;}
    setOauthPending(true);
    try {
      const res = await fetch("/api/settings/oauth/url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: selectedProvider.value }),
      });
      const data = await res.json();
      if (!res.ok) {throw new Error(data.error);}

      const width = 600;
      const height = 700;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      const win = window.open(
        data.url,
        "OpenClaw OAuth",
        `width=${width},height=${height},left=${left},top=${top},status=no,menubar=no`
      );
      setOauthWindow(win);
    } catch (err) {
      setSaveResult({ ok: false, message: String(err) });
      setOauthPending(false);
    }
  };

  // Copilot Device Flow
  const handleStartCopilotFlow = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/copilot/start", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {throw new Error(data.error);}

      setUserCode(data.user_code);
      setVerificationUri(data.verification_uri);
      setDeviceCode(data.device_code);

      // Start polling
      const interval = setInterval(async () => {
        try {
          const pollRes = await fetch("/api/settings/copilot/poll", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device_code: data.device_code }),
          });
          const pollData = await pollRes.json();
          if (pollData.status === "complete") {
            clearInterval(interval);
            setDevicePollInterval(null);
            setSaveResult({ ok: true, message: "GitHub Copilot connected!" });
            setTimeout(() => {
              resetWizard();
              fetchData();
            }, 2000);
          } else if (pollData.status === "error") {
            clearInterval(interval);
            setDevicePollInterval(null);
            setSaveResult({ ok: false, message: pollData.error });
          }
        } catch (err) {
          console.error("Poll error:", err);
        }
      }, (data.interval || 5) * 1000);

      setDevicePollInterval(interval);
    } catch (err) {
      setSaveResult({ ok: false, message: String(err) });
    } finally {
      setSaving(false);
    }
  };

  const resetWizard = () => {
    setSelectedProvider(null);
    setSelectedMethod(null);
    setApiKeyInput("");
    setTokenInput("");
    setTokenName("");
    setModelInput("");
    setShowKey(false);
    setSaveResult(null);
    setOauthPending(false);
    setDeviceCode(null);
    setUserCode(null);
    setVerificationUri(null);
    if (devicePollInterval) {
      clearInterval(devicePollInterval);
      setDevicePollInterval(null);
    }
  };

  // Go back
  const goBack = () => {
    if (selectedMethod) {
      setSelectedMethod(null);
      setApiKeyInput("");
      setModelInput("");
      setShowKey(false);
      setSaveResult(null);
    } else if (selectedProvider) {
      setSelectedProvider(null);
    }
  };

  // Determine current step
  const step = !selectedProvider ? "provider" : !selectedMethod ? "method" : "configure";

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="flex flex-col h-full" style={{ background: "var(--color-bg)" }}>
      {/* Header */}
      <div
        className="px-6 py-4 border-b flex items-center gap-3"
        style={{ borderColor: "var(--color-border)" }}
      >
        {step !== "provider" && (
          <button
            onClick={goBack}
            style={{
              background: "none",
              border: "none",
              color: "var(--color-text-muted)",
              cursor: "pointer",
              padding: "4px",
              display: "flex",
              alignItems: "center",
            }}
          >
            <ArrowLeftIcon size={18} />
          </button>
        )}
        <h1 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>
          Settings
        </h1>
        {selectedProvider && (
          <span style={{ color: "var(--color-text-muted)", fontSize: "0.875rem" }}>
            / {selectedProvider.label}
            {selectedMethod ? ` / ${selectedMethod.label}` : ""}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-2xl space-y-6">
          {loading ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "4rem",
                color: "var(--color-text-muted)",
                fontSize: "0.875rem",
              }}
            >
              Loading settings…
            </div>
          ) : (
            <>
              {/* Current Configuration */}
              {step === "provider" && (currentModel || authProfiles.length > 0) && (
                <section
                  style={{
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "0.625rem",
                    padding: "0.75rem 1rem",
                  }}
                >
                  <div style={{ fontWeight: 500, fontSize: "0.875rem", color: "var(--color-text)", marginBottom: "0.375rem" }}>
                    Current Configuration
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", lineHeight: 1.6 }}>
                    {currentModel && (
                      <div>
                        Model:{" "}
                        <span style={{ color: "var(--color-text)", fontWeight: 500 }}>
                          {typeof currentModel === "string" ? currentModel : String((currentModel as Record<string, unknown>)?.primary ?? "none")}
                        </span>
                      </div>
                    )}
                    {authProfiles.length > 0 && (
                      <div>
                        Auth:{" "}
                        <span style={{ color: "var(--color-text)", fontWeight: 500 }}>
                          {authProfiles.map((p) => p.provider).join(", ")}
                        </span>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {/* Step 1: Provider Selection */}
              {step === "provider" && (
                <section>
                  <h2
                    style={{
                      fontSize: "0.8125rem",
                      fontWeight: 600,
                      color: "var(--color-text-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      marginBottom: "0.75rem",
                    }}
                  >
                    Select Provider
                  </h2>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
                    {providers.map((provider) => (
                      <button
                        key={provider.value}
                        onClick={() => {
                          setSelectedProvider(provider);
                          // Auto-select if only one supported method
                          const supported = provider.methods.filter((m) => m.type !== "unsupported");
                          if (supported.length === 1) {
                            setSelectedMethod(supported[0]);
                            if (supported[0].defaultModel) {
                              setModelInput(supported[0].defaultModel);
                            }
                          }
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "0.75rem 1rem",
                          background: "var(--color-surface)",
                          border: "1px solid var(--color-border)",
                          borderRadius: "0.625rem",
                          cursor: "pointer",
                          textAlign: "left",
                          transition: "all 0.15s ease",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = "var(--color-surface-hover)";
                          e.currentTarget.style.borderColor = "var(--color-border-strong)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = "var(--color-surface)";
                          e.currentTarget.style.borderColor = "var(--color-border)";
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 500, fontSize: "0.875rem", color: "var(--color-text)" }}>
                            {provider.label}
                          </div>
                          {provider.hint && (
                            <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", marginTop: "0.125rem" }}>
                              {provider.hint}
                            </div>
                          )}
                        </div>
                        <ChevronRight size={16} />
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {/* Step 2: Auth Method Selection (only if provider has multiple) */}
              {step === "method" && selectedProvider && (
                <section>
                  <h2
                    style={{
                      fontSize: "0.8125rem",
                      fontWeight: 600,
                      color: "var(--color-text-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      marginBottom: "0.75rem",
                    }}
                  >
                    Choose Authentication Method
                  </h2>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
                    {selectedProvider.methods.map((method) => {
                      const isUnsupported = method.type === "unsupported";
                      return (
                        <button
                          key={method.value}
                          disabled={isUnsupported}
                          onClick={() => {
                            if (isUnsupported) {return;}
                            setSelectedMethod(method);
                            if (method.defaultModel) {
                              setModelInput(method.defaultModel);
                            }
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "0.75rem 1rem",
                            background: "var(--color-surface)",
                            border: "1px solid var(--color-border)",
                            borderRadius: "0.625rem",
                            cursor: isUnsupported ? "not-allowed" : "pointer",
                            textAlign: "left",
                            transition: "all 0.15s ease",
                            opacity: isUnsupported ? 0.5 : 1,
                          }}
                          onMouseEnter={(e) => {
                            if (!isUnsupported) {
                              e.currentTarget.style.background = "var(--color-surface-hover)";
                              e.currentTarget.style.borderColor = "var(--color-border-strong)";
                            }
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = "var(--color-surface)";
                            e.currentTarget.style.borderColor = "var(--color-border)";
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: "0.625rem" }}>
                            <div style={{ color: "var(--color-text-muted)" }}>
                              {method.type === "api-key" ? <KeyIcon size={16} /> : <ServerIcon size={16} />}
                            </div>
                            <div>
                              <div style={{ fontWeight: 500, fontSize: "0.875rem", color: "var(--color-text)" }}>
                                {method.label}
                                {isUnsupported && <span style={{ fontSize: "0.7rem", marginLeft: "0.5rem", color: "var(--color-text-muted)" }}>(CLI only)</span>}
                              </div>
                              {method.hint && (
                                <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", marginTop: "0.125rem" }}>
                                  {method.hint}
                                </div>
                              )}
                            </div>
                          </div>
                          {!isUnsupported && <ChevronRight size={16} />}
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Step 3: Configure */}
              {step === "configure" && selectedMethod && (
                <section>
                  {/* OAuth Flow */}
                  {selectedMethod.type === "oauth" && (
                    <div style={{ textAlign: "center", padding: "1.5rem 0" }}>
                      <div style={{ marginBottom: "1.5rem" }}>
                        <div style={{ 
                          width: "48px", 
                          height: "48px", 
                          borderRadius: "12px", 
                          background: "var(--color-accent-light)", 
                          color: "var(--color-accent)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          margin: "0 auto 1rem"
                        }}>
                          <ServerIcon size={24} />
                        </div>
                        <h3 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.5rem" }}>
                          Connect {selectedProvider?.label}
                        </h3>
                        <p style={{ fontSize: "0.875rem", color: "var(--color-text-muted)" }}>
                          {selectedMethod.hint || "Authorize OpenClaw to access your account."}
                        </p>
                      </div>

                      <button
                        onClick={handleConnectOAuth}
                        disabled={oauthPending}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.625rem",
                          padding: "0.75rem 2rem",
                          background: "var(--color-accent)",
                          color: "white",
                          border: "none",
                          borderRadius: "0.625rem",
                          fontSize: "0.875rem",
                          fontWeight: 600,
                          cursor: oauthPending ? "not-allowed" : "pointer",
                          opacity: oauthPending ? 0.7 : 1,
                          transition: "all 0.15s ease",
                        }}
                      >
                        {oauthPending ? "Connecting..." : `Connect ${selectedProvider?.label}`}
                        {!oauthPending && <ChevronRight size={16} />}
                      </button>
                    </div>
                  )}

                  {/* Device Flow (GitHub Copilot) */}
                  {selectedMethod.type === "device-flow" && (
                    <div style={{ textAlign: "center", padding: "1rem 0" }}>
                      {!userCode ? (
                        <button
                          onClick={handleStartCopilotFlow}
                          disabled={saving}
                          style={{
                            padding: "0.75rem 2rem",
                            background: "var(--color-accent)",
                            color: "white",
                            border: "none",
                            borderRadius: "0.625rem",
                            fontSize: "0.875rem",
                            fontWeight: 600,
                            cursor: "pointer",
                          }}
                        >
                          {saving ? "Starting..." : "Start GitHub Authorization"}
                        </button>
                      ) : (
                        <div>
                          <p style={{ fontSize: "0.875rem", marginBottom: "1rem" }}>
                            Enter this code on GitHub to authorize Copilot:
                          </p>
                          <div style={{ 
                            fontSize: "2rem", 
                            fontWeight: 700, 
                            letterSpacing: "0.2em",
                            padding: "1rem",
                            background: "var(--color-surface-hover)",
                            borderRadius: "0.75rem",
                            border: "2px solid var(--color-border-strong)",
                            marginBottom: "1.5rem",
                            fontFamily: "monospace"
                          }}>
                            {userCode}
                          </div>
                          <a 
                            href={verificationUri || "#"} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "0.5rem",
                              color: "var(--color-accent)",
                              textDecoration: "none",
                              fontSize: "0.875rem",
                              fontWeight: 600
                            }}
                          >
                            Open GitHub Activation <ExternalLinkIcon size={16} />
                          </a>
                          <p style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", marginTop: "1.5rem" }}>
                            Waiting for you to authorize in the browser...
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Token Flow (Anthropic, etc.) */}
                  {selectedMethod.type === "token" && (
                    <>
                      <div style={{ marginBottom: "1.25rem" }}>
                        <h2 style={{ fontSize: "0.8125rem", fontWeight: 600, color: "var(--color-text-muted)", textTransform: "uppercase", marginBottom: "0.75rem" }}>
                          Setup Token
                        </h2>
                        <textarea
                          value={tokenInput}
                          onChange={(e) => setTokenInput(e.target.value)}
                          placeholder="Paste your setup-token from the terminal..."
                          autoFocus
                          style={{
                            width: "100%",
                            height: "100px",
                            padding: "0.75rem",
                            fontSize: "0.875rem",
                            fontFamily: "monospace",
                            background: "var(--color-surface)",
                            border: "1px solid var(--color-border)",
                            borderRadius: "0.5rem",
                            color: "var(--color-text)",
                            resize: "none"
                          }}
                        />
                      </div>
                      <div style={{ marginBottom: "1.5rem" }}>
                        <h2 style={{ fontSize: "0.8125rem", fontWeight: 600, color: "var(--color-text-muted)", textTransform: "uppercase", marginBottom: "0.75rem" }}>
                          Profile Name (optional)
                        </h2>
                        <input
                          type="text"
                          value={tokenName}
                          onChange={(e) => setTokenName(e.target.value)}
                          placeholder="default"
                          style={{
                            width: "100%",
                            padding: "0.625rem 0.75rem",
                            fontSize: "0.875rem",
                            background: "var(--color-surface)",
                            border: "1px solid var(--color-border)",
                            borderRadius: "0.5rem",
                            color: "var(--color-text)"
                          }}
                        />
                      </div>
                    </>
                  )}

                  {/* API Key Flow */}
                  {selectedMethod.type === "api-key" && (
                    <div style={{ marginBottom: "1.5rem" }}>
                      <h2 style={{ fontSize: "0.8125rem", fontWeight: 600, color: "var(--color-text-muted)", textTransform: "uppercase", marginBottom: "0.75rem" }}>
                        API Key
                      </h2>
                      <div style={{ position: "relative" }}>
                        <input
                          type={showKey ? "text" : "password"}
                          value={apiKeyInput}
                          onChange={(e) => setApiKeyInput(e.target.value)}
                          placeholder="sk-..."
                          autoFocus
                          style={{
                            width: "100%",
                            padding: "0.625rem 2.5rem 0.625rem 0.75rem",
                            fontSize: "0.875rem",
                            fontFamily: "monospace",
                            background: "var(--color-surface)",
                            border: "1px solid var(--color-border)",
                            borderRadius: "0.5rem",
                            color: "var(--color-text)",
                          }}
                        />
                        <button
                          onClick={() => setShowKey(!showKey)}
                          style={{
                            position: "absolute", right: "0.5rem", top: "50%", transform: "translateY(-50%)",
                            background: "none", border: "none", cursor: "pointer", color: "var(--color-text-muted)"
                          }}
                        >
                          {showKey ? <EyeOffIcon /> : <EyeIcon />}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Common Model & Save for non-OAuth/non-Copilot */}
                  {(selectedMethod.type === "api-key" || selectedMethod.type === "token") && (
                    <>
                      <div style={{ marginBottom: "1.5rem" }}>
                        <h2 style={{ fontSize: "0.8125rem", fontWeight: 600, color: "var(--color-text-muted)", textTransform: "uppercase", marginBottom: "0.75rem" }}>
                          Default Model
                        </h2>
                        <input
                          type="text"
                          value={modelInput}
                          onChange={(e) => setModelInput(e.target.value)}
                          placeholder={selectedMethod.defaultModel ?? "provider/model-name"}
                          style={{
                            width: "100%",
                            padding: "0.625rem 0.75rem",
                            fontSize: "0.875rem",
                            fontFamily: "monospace",
                            background: "var(--color-surface)",
                            border: "1px solid var(--color-border)",
                            borderRadius: "0.5rem",
                            color: "var(--color-text)",
                          }}
                        />
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                        <button
                          onClick={handleSave}
                          disabled={saving || (selectedMethod.type === "api-key" ? !apiKeyInput.trim() : !tokenInput.trim())}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.625rem",
                            padding: "0.625rem 1.25rem",
                            background: "var(--color-accent)",
                            color: "white",
                            border: "none",
                            borderRadius: "0.5rem",
                            fontSize: "0.875rem",
                            fontWeight: 600,
                            cursor: "pointer",
                            transition: "opacity 0.15s ease",
                          }}
                        >
                          {saving ? "Saving..." : "Save Configuration"}
                          {!saving && <ChevronRight size={16} />}
                        </button>
                      </div>
                    </>
                  )}

                  {/* Status Messages */}
                  {saveResult && (
                    <div
                      style={{
                        marginTop: "1.25rem",
                        padding: "0.875rem 1rem",
                        borderRadius: "0.625rem",
                        fontSize: "0.875rem",
                        background: saveResult.ok ? "var(--color-accent-light)" : "#fee2e2",
                        color: saveResult.ok ? "var(--color-accent)" : "#991b1b",
                        border: `1px solid ${saveResult.ok ? "var(--color-accent)" : "#fecaca"}`,
                      }}
                    >
                      {saveResult.message}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
