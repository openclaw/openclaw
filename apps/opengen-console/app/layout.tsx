import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenGen 控制台 | OpenClaw",
  description: "OpenGen Next.js 中文控制台",
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
