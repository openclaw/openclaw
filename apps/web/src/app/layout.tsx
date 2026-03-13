import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenClaw — Personal AI Assistant",
  description:
    "Your personal AI assistant across WhatsApp, Telegram, Slack, Discord, and 20+ more channels.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
