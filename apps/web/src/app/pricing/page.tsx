"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import Navbar from "@/components/Navbar";
import { PLANS } from "@/lib/stripe";

export default function PricingPage() {
  const { data: session } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isNew = searchParams.get("new") === "true";
  const [interval, setInterval] = useState<"monthly" | "yearly">("monthly");

  async function handleCheckout(plan: "starter" | "growth" | "pro") {
    if (!session) {
      router.push("/register");
      return;
    }
    const res = await fetch("/api/stripe/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan, interval }),
    });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
  }

  function displayPrice(plan: "starter" | "growth" | "pro") {
    if (interval === "yearly") {
      const monthly = Math.round(PLANS[plan].yearlyPrice / 12);
      return { main: monthly, sub: "/ month, billed yearly" };
    }
    return { main: PLANS[plan].monthlyPrice, sub: "/ month" };
  }

  return (
    <>
      <Navbar />
      <main style={{ padding: "5rem 1.5rem" }}>
        <div className="container">
          {isNew && (
            <div style={{
              background: "rgba(224,90,43,0.08)",
              border: "1px solid rgba(224,90,43,0.25)",
              borderRadius: 12,
              padding: "1rem 1.5rem",
              textAlign: "center",
              marginBottom: "2.5rem",
              fontSize: "0.95rem",
            }}>
              Account created! Pick a plan to get started.
            </div>
          )}
          <h1 style={{ textAlign: "center", fontSize: "2.5rem", fontWeight: 800, marginBottom: "0.75rem" }}>
            Simple, transparent pricing
          </h1>
          <p style={{ textAlign: "center", color: "#777", marginBottom: "2rem", fontSize: "1.1rem" }}>
            Cancel anytime.
          </p>

          {/* Billing interval toggle */}
          <div style={{ display: "flex", justifyContent: "center", marginBottom: "3.5rem" }}>
            <div style={{
              background: "#111",
              border: "1px solid #222",
              borderRadius: 999,
              padding: "0.25rem",
              display: "inline-flex",
              gap: "0.25rem",
            }}>
              {(["monthly", "yearly"] as const).map((i) => (
                <button
                  key={i}
                  onClick={() => setInterval(i)}
                  style={{
                    padding: "0.4rem 1.1rem",
                    borderRadius: 999,
                    border: "none",
                    cursor: "pointer",
                    fontSize: "0.875rem",
                    fontWeight: 600,
                    background: interval === i ? "#e05a2b" : "transparent",
                    color: interval === i ? "#fff" : "#777",
                    transition: "all 0.15s",
                  }}
                >
                  {i === "monthly" ? "Monthly" : "Yearly"}
                  {i === "yearly" && (
                    <span style={{
                      marginLeft: "0.4rem",
                      background: "rgba(255,255,255,0.15)",
                      padding: "0.1rem 0.4rem",
                      borderRadius: 999,
                      fontSize: "0.7rem",
                    }}>
                      2 months free
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: "1.5rem",
            maxWidth: 960,
            margin: "0 auto",
          }}>
            {/* Starter */}
            <div style={{ background: "#111", border: "1px solid #222", borderRadius: 16, padding: "2rem", display: "flex", flexDirection: "column" }}>
              <div style={{ fontWeight: 600, fontSize: "1.1rem", marginBottom: "0.25rem" }}>{PLANS.starter.name}</div>
              <div style={{ color: "#777", fontSize: "0.875rem", marginBottom: "1.5rem" }}>{PLANS.starter.description}</div>
              <div style={{ marginBottom: "1.75rem" }}>
                <span style={{ fontSize: "2.5rem", fontWeight: 800 }}>${displayPrice("starter").main}</span>
                <span style={{ color: "#666", fontSize: "0.9rem" }}> {displayPrice("starter").sub}</span>
              </div>
              <ul style={{ listStyle: "none", flex: 1, marginBottom: "1.5rem" }}>
                {PLANS.starter.features.map((f) => (
                  <li key={f} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.6rem", fontSize: "0.9rem", color: "#ccc" }}>
                    <span style={{ color: "#22c55e" }}>✓</span> {f}
                  </li>
                ))}
              </ul>
              <button className="btn btn-outline" style={{ width: "100%" }} onClick={() => handleCheckout("starter")}>
                {session ? "Upgrade to Starter" : "Get started"}
              </button>
            </div>

            {/* Growth */}
            <div style={{ background: "#111", border: "2px solid #e05a2b", borderRadius: 16, padding: "2rem", display: "flex", flexDirection: "column", position: "relative" }}>
              <div style={{
                position: "absolute", top: -14, left: "50%", transform: "translateX(-50%)",
                background: "#e05a2b", color: "#fff", fontSize: "0.75rem", fontWeight: 700,
                padding: "0.25rem 0.8rem", borderRadius: 999, letterSpacing: "0.05em", whiteSpace: "nowrap",
              }}>MOST POPULAR</div>
              <div style={{ fontWeight: 600, fontSize: "1.1rem", marginBottom: "0.25rem" }}>{PLANS.growth.name}</div>
              <div style={{ color: "#777", fontSize: "0.875rem", marginBottom: "1.5rem" }}>{PLANS.growth.description}</div>
              <div style={{ marginBottom: "1.75rem" }}>
                <span style={{ fontSize: "2.5rem", fontWeight: 800 }}>${displayPrice("growth").main}</span>
                <span style={{ color: "#666", fontSize: "0.9rem" }}> {displayPrice("growth").sub}</span>
              </div>
              <ul style={{ listStyle: "none", flex: 1, marginBottom: "1.5rem" }}>
                {PLANS.growth.features.map((f) => (
                  <li key={f} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.6rem", fontSize: "0.9rem", color: "#ccc" }}>
                    <span style={{ color: "#22c55e" }}>✓</span> {f}
                  </li>
                ))}
              </ul>
              <button className="btn btn-primary" style={{ width: "100%" }} onClick={() => handleCheckout("growth")}>
                {session ? "Upgrade to Growth" : "Get started"}
              </button>
            </div>

            {/* Pro */}
            <div style={{ background: "#111", border: "1px solid #222", borderRadius: 16, padding: "2rem", display: "flex", flexDirection: "column" }}>
              <div style={{ fontWeight: 600, fontSize: "1.1rem", marginBottom: "0.25rem" }}>{PLANS.pro.name}</div>
              <div style={{ color: "#777", fontSize: "0.875rem", marginBottom: "1.5rem" }}>{PLANS.pro.description}</div>
              <div style={{ marginBottom: "1.75rem" }}>
                <span style={{ fontSize: "2.5rem", fontWeight: 800 }}>${displayPrice("pro").main}</span>
                <span style={{ color: "#666", fontSize: "0.9rem" }}> {displayPrice("pro").sub}</span>
              </div>
              <ul style={{ listStyle: "none", flex: 1, marginBottom: "1.5rem" }}>
                {PLANS.pro.features.map((f) => (
                  <li key={f} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.6rem", fontSize: "0.9rem", color: "#ccc" }}>
                    <span style={{ color: "#22c55e" }}>✓</span> {f}
                  </li>
                ))}
              </ul>
              <button className="btn btn-outline" style={{ width: "100%" }} onClick={() => handleCheckout("pro")}>
                {session ? "Upgrade to Pro" : "Get started"}
              </button>
            </div>
          </div>

          <p style={{ textAlign: "center", color: "#555", marginTop: "3rem", fontSize: "0.875rem" }}>
            Questions? <Link href="mailto:support@openclaw.ai" style={{ color: "#777" }}>Contact us</Link>
          </p>
        </div>
      </main>
    </>
  );
}
