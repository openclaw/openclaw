import "./globals.css";

export const metadata = {
  title: "Platinum Fang OS",
  description: "Command Autonomous Intelligence",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen text-foreground">{children}</body>
    </html>
  );
}
