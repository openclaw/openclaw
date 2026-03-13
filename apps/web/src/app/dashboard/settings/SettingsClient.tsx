"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  MODELS,
  MODELS_BY_PROVIDER,
  PROVIDER_LABELS,
  type Provider,
} from "@/lib/models";

type AiSettings = {
  preferredModel: string;
  hasAnthropicKey: boolean;
  hasOpenaiKey: boolean;
  hasGeminiKey: boolean;
};

type Props = {
  user: { id: string; name: string | null; email: string | null; hasPassword: boolean };
  aiSettings: AiSettings;
};

const PROVIDER_DOCS: Record<Provider, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai:    "https://platform.openai.com/api-keys",
  google:    "https://aistudio.google.com/app/apikey",
};

const PROVIDER_PLACEHOLDERS: Record<Provider, string> = {
  anthropic: "sk-ant-...",
  openai:    "sk-...",
  google:    "AIza...",
};

export default function SettingsClient({ user, aiSettings }: Props) {
  const router = useRouter();

  // ─── AI settings ────────────────────────────────────────────────────────

  const [preferredModel, setPreferredModel] = useState(aiSettings.preferredModel);
  const [hasKey, setHasKey] = useState<Record<Provider, boolean>>({
    anthropic: aiSettings.hasAnthropicKey,
    openai:    aiSettings.hasOpenaiKey,
    google:    aiSettings.hasGeminiKey,
  });
  const [keyInput, setKeyInput] = useState<Record<Provider, string>>({
    anthropic: "",
    openai:    "",
    google:    "",
  });
  const [aiMsg, setAiMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  async function saveModel(modelId: string) {
    setAiMsg(null);
    setAiLoading(true);
    const res = await fetch("/api/user/aikeys", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setModel", model: modelId }),
    });
    setAiLoading(false);
    if (res.ok) {
      setPreferredModel(modelId);
      setAiMsg({ ok: true, text: "Default model saved." });
      router.refresh();
    } else {
      const d = await res.json();
      setAiMsg({ ok: false, text: d.error ?? "Failed to save model." });
    }
  }

  async function saveProviderKey(provider: Provider, value: string) {
    setAiMsg(null);
    setAiLoading(true);
    const res = await fetch("/api/user/aikeys", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setKey", provider, apiKey: value }),
    });
    const data = await res.json();
    setAiLoading(false);
    if (res.ok) {
      setHasKey((prev) => ({ ...prev, [provider]: !!value }));
      setKeyInput((prev) => ({ ...prev, [provider]: "" }));
      setAiMsg({ ok: true, text: value ? `${PROVIDER_LABELS[provider]} key saved.` : `${PROVIDER_LABELS[provider]} key removed.` });
      router.refresh();
    } else {
      setAiMsg({ ok: false, text: data.error ?? "Failed to save key." });
    }
  }

  // ─── Profile form ────────────────────────────────────────────────────────

  const [name, setName] = useState(user.name ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setProfileMsg(null);
    setProfileLoading(true);
    const res = await fetch("/api/user/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email }),
    });
    const data = await res.json();
    setProfileLoading(false);
    if (res.ok) {
      setProfileMsg({ ok: true, text: "Profile updated." });
      router.refresh();
    } else {
      setProfileMsg({ ok: false, text: data.error ?? "Failed to update profile." });
    }
  }

  // ─── Password form ────────────────────────────────────────────────────────

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pwLoading, setPwLoading] = useState(false);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    if (newPassword !== confirmPassword) {
      setPwMsg({ ok: false, text: "Passwords do not match." });
      return;
    }
    setPwLoading(true);
    const res = await fetch("/api/user/password", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();
    setPwLoading(false);
    if (res.ok) {
      setPwMsg({ ok: true, text: "Password changed successfully." });
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
    } else {
      setPwMsg({ ok: false, text: data.error ?? "Failed to change password." });
    }
  }

  // ─── Delete account ───────────────────────────────────────────────────────

  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteMsg, setDeleteMsg] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  async function deleteAccount(e: React.FormEvent) {
    e.preventDefault();
    if (deleteConfirm !== "delete my account") {
      setDeleteMsg('Type "delete my account" to confirm.');
      return;
    }
    setDeleteLoading(true);
    const res = await fetch("/api/user/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: deletePassword }),
    });
    const data = await res.json();
    if (res.ok) {
      await signOut({ callbackUrl: "/" });
    } else {
      setDeleteMsg(data.error ?? "Failed to delete account.");
      setDeleteLoading(false);
    }
  }

  // ─── Shared styles ────────────────────────────────────────────────────────

  const card: React.CSSProperties = {
    background: "#111",
    border: "1px solid #1f1f1f",
    borderRadius: 16,
    padding: "1.75rem",
    marginBottom: "1.5rem",
  };

  const savedBadge: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.35rem",
    background: "rgba(34,197,94,0.07)",
    border: "1px solid rgba(34,197,94,0.2)",
    borderRadius: 6,
    padding: "0.2rem 0.6rem",
    fontSize: "0.78rem",
    color: "#22c55e",
  };

  const selectedModel = MODELS.find((m) => m.id === preferredModel);
  const providers: Provider[] = ["anthropic", "openai", "google"];

  return (
    <div>
      {/* ── AI Settings ─────────────────────────────────────────────────── */}
      <div style={card}>
        <h2 style={{ fontWeight: 700, fontSize: "1.1rem", marginBottom: "0.35rem" }}>AI Settings</h2>
        <p style={{ color: "#777", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
          Choose your default model and add API keys. Keys you add are used directly (BYOK — no extra charge).
          Without a key, the platform&apos;s key is used and usage is billed at a markup
          (see per-model rates below) via your subscription.
        </p>

        {/* Model picker */}
        <div style={{ marginBottom: "1.75rem" }}>
          <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.5rem", color: "#ccc" }}>
            Default model
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {providers.map((prov) => (
              <div key={prov}>
                <div style={{ fontSize: "0.75rem", color: "#555", marginBottom: "0.35rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {PROVIDER_LABELS[prov]}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                  {MODELS_BY_PROVIDER[prov].map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => saveModel(m.id)}
                      disabled={aiLoading}
                      style={{
                        padding: "0.4rem 0.85rem",
                        borderRadius: 8,
                        border: m.id === preferredModel ? "1px solid #e05a2b" : "1px solid #2a2a2a",
                        background: m.id === preferredModel ? "rgba(224,90,43,0.1)" : "#0a0a0a",
                        color: m.id === preferredModel ? "#e05a2b" : "#aaa",
                        fontSize: "0.85rem",
                        cursor: "pointer",
                      }}
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {selectedModel && (
            <p style={{ marginTop: "0.6rem", fontSize: "0.8rem", color: "#555" }}>
              Selected: <span style={{ color: "#888" }}>{selectedModel.name}</span>
            </p>
          )}
        </div>

        {/* Per-provider key management */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {providers.map((prov) => (
            <div key={prov} style={{ borderTop: "1px solid #1a1a1a", paddingTop: "1.25rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.6rem" }}>
                <span style={{ fontSize: "0.9rem", fontWeight: 600, color: "#ccc" }}>
                  {PROVIDER_LABELS[prov]}
                </span>
                {hasKey[prov] ? (
                  <span style={savedBadge}>✓ key saved</span>
                ) : (
                  <span style={{ fontSize: "0.78rem", color: "#555" }}>no key — uses platform key</span>
                )}
                <a
                  href={PROVIDER_DOCS[prov]}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ marginLeft: "auto", fontSize: "0.78rem", color: "#e05a2b" }}
                >
                  Get key ↗
                </a>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", maxWidth: 440 }}>
                <input
                  type="password"
                  value={keyInput[prov]}
                  onChange={(e) => setKeyInput((prev) => ({ ...prev, [prov]: e.target.value }))}
                  placeholder={PROVIDER_PLACEHOLDERS[prov]}
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={aiLoading || !keyInput[prov]}
                  onClick={() => saveProviderKey(prov, keyInput[prov])}
                  style={{ whiteSpace: "nowrap" }}
                >
                  {hasKey[prov] ? "Replace" : "Save"}
                </button>
                {hasKey[prov] && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={aiLoading}
                    onClick={() => saveProviderKey(prov, "")}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {aiMsg && (
          <p className={aiMsg.ok ? "success-msg" : "error-msg"} style={{ marginTop: "1rem" }}>
            {aiMsg.text}
          </p>
        )}
      </div>

      {/* ── Profile ──────────────────────────────────────────────────────── */}
      <div style={card}>
        <h2 style={{ fontWeight: 700, fontSize: "1.1rem", marginBottom: "1.25rem" }}>Profile</h2>
        <form onSubmit={saveProfile} style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: 440 }}>
          <div>
            <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.4rem", color: "#ccc" }}>
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.4rem", color: "#ccc" }}>
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          {profileMsg && (
            <p className={profileMsg.ok ? "success-msg" : "error-msg"}>{profileMsg.text}</p>
          )}
          <button type="submit" className="btn btn-primary" disabled={profileLoading} style={{ alignSelf: "flex-start" }}>
            {profileLoading ? "Saving…" : "Save changes"}
          </button>
        </form>
      </div>

      {/* ── Password ─────────────────────────────────────────────────────── */}
      <div style={card}>
        <h2 style={{ fontWeight: 700, fontSize: "1.1rem", marginBottom: "1.25rem" }}>
          {user.hasPassword ? "Change password" : "Set a password"}
        </h2>
        <form onSubmit={changePassword} style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: 440 }}>
          {user.hasPassword && (
            <div>
              <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.4rem", color: "#ccc" }}>
                Current password
              </label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>
          )}
          <div>
            <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.4rem", color: "#ccc" }}>
              New password
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 8 characters"
              minLength={8}
              required
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.4rem", color: "#ccc" }}>
              Confirm new password
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          {pwMsg && (
            <p className={pwMsg.ok ? "success-msg" : "error-msg"}>{pwMsg.text}</p>
          )}
          <button type="submit" className="btn btn-primary" disabled={pwLoading} style={{ alignSelf: "flex-start" }}>
            {pwLoading ? "Saving…" : "Update password"}
          </button>
        </form>
      </div>

      {/* ── Danger zone ───────────────────────────────────────────────────── */}
      <div style={{ ...card, border: "1px solid rgba(239,68,68,0.3)" }}>
        <h2 style={{ fontWeight: 700, fontSize: "1.1rem", color: "#ef4444", marginBottom: "0.5rem" }}>
          Danger zone
        </h2>
        <p style={{ color: "#888", fontSize: "0.875rem", marginBottom: "1.25rem" }}>
          Permanently delete your account and all associated data. This cannot be undone.
          Any active subscription will be cancelled immediately.
        </p>

        {!showDelete ? (
          <button
            className="btn"
            style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.3)" }}
            onClick={() => setShowDelete(true)}
          >
            Delete my account
          </button>
        ) : (
          <form onSubmit={deleteAccount} style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: 440 }}>
            {user.hasPassword && (
              <div>
                <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.4rem", color: "#ccc" }}>
                  Your password
                </label>
                <input
                  type="password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>
            )}
            <div>
              <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.4rem", color: "#ccc" }}>
                Type <strong>delete my account</strong> to confirm
              </label>
              <input
                type="text"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder="delete my account"
              />
            </div>
            {deleteMsg && <p className="error-msg">{deleteMsg}</p>}
            <div style={{ display: "flex", gap: "0.6rem" }}>
              <button
                type="submit"
                disabled={deleteLoading}
                className="btn"
                style={{ background: "#ef4444", color: "#fff" }}
              >
                {deleteLoading ? "Deleting…" : "Delete account"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => { setShowDelete(false); setDeleteMsg(""); }}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
