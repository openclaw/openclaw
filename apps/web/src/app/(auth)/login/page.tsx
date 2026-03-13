"use client";

import { useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError("Invalid email or password.");
    } else {
      router.push(callbackUrl);
    }
  }

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "2rem 1.5rem",
    }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ textAlign: "center", marginBottom: "2rem" }}>
          <Link href="/" style={{ fontSize: "1.5rem", fontWeight: 700 }}>🦞 OpenClaw</Link>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginTop: "1.5rem" }}>Welcome back</h1>
          <p style={{ color: "#777", fontSize: "0.9rem", marginTop: "0.4rem" }}>Sign in to your account</p>
        </div>

        <div style={{
          background: "#111",
          border: "1px solid #222",
          borderRadius: 16,
          padding: "2rem",
        }}>
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.4rem", color: "#ccc" }}>
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.4rem", color: "#ccc" }}>
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />
            </div>

            {error && <p className="error-msg">{error}</p>}

            <button type="submit" className="btn btn-primary" disabled={loading} style={{ width: "100%", marginTop: "0.5rem" }}>
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <div style={{ marginTop: "1.25rem", textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", margin: "1rem 0" }}>
              <div style={{ flex: 1, height: 1, background: "#222" }} />
              <span style={{ color: "#555", fontSize: "0.8rem" }}>or</span>
              <div style={{ flex: 1, height: 1, background: "#222" }} />
            </div>
            <button
              className="btn btn-outline"
              style={{ width: "100%", marginBottom: "0.6rem" }}
              onClick={() => signIn("github", { callbackUrl })}
            >
              Continue with GitHub
            </button>
            <button
              className="btn btn-outline"
              style={{ width: "100%" }}
              onClick={() => signIn("google", { callbackUrl })}
            >
              Continue with Google
            </button>
          </div>
        </div>

        <p style={{ textAlign: "center", marginTop: "1.25rem", color: "#666", fontSize: "0.875rem" }}>
          Don&apos;t have an account?{" "}
          <Link href="/register" style={{ color: "#e05a2b" }}>Create one</Link>
        </p>
      </div>
    </div>
  );
}
