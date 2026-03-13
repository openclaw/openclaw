import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Navbar from "@/components/Navbar";
import SettingsClient from "./SettingsClient";
import { DEFAULT_MODEL_ID } from "@/lib/models";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login?callbackUrl=/dashboard/settings");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      password: true,
      anthropicApiKey: true,
      openaiApiKey: true,
      geminiApiKey: true,
      preferredModel: true,
    },
  });

  if (!user) redirect("/login");

  return (
    <>
      <Navbar />
      <main style={{ padding: "3rem 1.5rem" }}>
        <div className="container" style={{ maxWidth: 700 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "2rem" }}>
            <Link href="/dashboard" style={{ color: "#666", fontSize: "0.9rem" }}>
              ← Dashboard
            </Link>
            <span style={{ color: "#333" }}>/</span>
            <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>Account settings</h1>
          </div>

          <SettingsClient
            user={{
              id: user.id,
              name: user.name,
              email: user.email,
              hasPassword: !!user.password,
            }}
            aiSettings={{
              preferredModel: user.preferredModel ?? DEFAULT_MODEL_ID,
              hasAnthropicKey: !!user.anthropicApiKey,
              hasOpenaiKey: !!user.openaiApiKey,
              hasGeminiKey: !!user.geminiApiKey,
            }}
          />
        </div>
      </main>
    </>
  );
}
