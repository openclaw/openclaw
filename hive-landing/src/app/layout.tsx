import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Hive — Privacy-Preserving Swarm Infrastructure for Sovereign AI Agents",
  description:
    "Queen-centric swarm infrastructure that solves version drift, security fragmentation, supply-chain poisoning, and privacy leakage for autonomous AI agent deployments.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-neutral-950 text-neutral-100 antialiased">
        {children}
      </body>
    </html>
  );
}
