import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenGen Console | OpenClaw",
  description: "OpenGen Next.js Console",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="opengen-app">{children}</body>
    </html>
  );
}
