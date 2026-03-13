"use client";

import { useState } from "react";

export default function BillingButton({ label }: { label: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePortal() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe/portal", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong");
        return;
      }
      if (data.url) window.location.href = data.url;
    } catch {
      setError("Failed to open billing portal");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button className="btn btn-outline" onClick={handlePortal} disabled={loading}>
        {loading ? "Loading..." : label}
      </button>
      {error && <p className="text-red-500 text-sm mt-1">{error}</p>}
    </div>
  );
}
