import type { Metadata } from "next";
import { Quicksand } from "next/font/google";
import "./globals.css";

export const metadata: Metadata = {
  title: "Remotion Forge Studio",
  description: "作品メタを一元管理する Remotion Studio ダッシュボード",
};

const quicksand = Quicksand({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-quicksand",
});

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className={quicksand.variable}>
      <body>{children}</body>
    </html>
  );
}
