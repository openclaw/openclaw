import type { Metadata } from "next";

// Force dynamic rendering — cafe page uses client-side canvas game,
// and the SSR middleware requires Supabase env vars not available at build time
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: "思考者咖啡廳 — Thinker's Cafe",
  description: "真人。真實的改變。活的數據。",
  openGraph: {
    title: "思考者咖啡廳 — Thinker's Cafe",
    description: "真人。真實的改變。活的數據。",
    url: "https://www.thinker.cafe",
    siteName: "思考者咖啡廳",
    locale: "zh_TW",
    type: "website",
  },
};

export default function CafeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <style>{`
        /* Hide parent layout navigation and footer for cafe */
        nav, .site-navigation, header, footer, .site-footer {
          display: none !important;
        }
        /* Override parent gradient background */
        .min-h-screen {
          background: #03070b !important;
        }
      `}</style>
      {children}
    </>
  );
}
