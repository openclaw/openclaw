import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8">
      <main className="flex flex-col items-center gap-8 max-w-2xl text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
          OpenClaw
        </h1>
        <p className="text-xl text-gray-600 dark:text-gray-400">
          Your AI assistant, connected to WhatsApp, Telegram, and more.
          No setup required.
        </p>

        <div className="flex gap-4 mt-4">
          <Link
            href="/login"
            className="rounded-full bg-foreground text-background px-6 py-3 text-sm font-semibold hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
          >
            Get Started
          </Link>
          <Link
            href="/docs"
            className="rounded-full border border-gray-300 dark:border-gray-700 px-6 py-3 text-sm font-semibold hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
          >
            Learn More
          </Link>
        </div>

        <div className="mt-12 grid grid-cols-1 sm:grid-cols-3 gap-6 text-left">
          <div className="p-6 rounded-lg border border-gray-200 dark:border-gray-800">
            <h3 className="font-semibold mb-2">1. Sign in with Google</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              One-click authentication. No passwords to remember.
            </p>
          </div>
          <div className="p-6 rounded-lg border border-gray-200 dark:border-gray-800">
            <h3 className="font-semibold mb-2">2. Connect your channels</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Scan a QR code for WhatsApp, enter a token for Telegram.
            </p>
          </div>
          <div className="p-6 rounded-lg border border-gray-200 dark:border-gray-800">
            <h3 className="font-semibold mb-2">3. Chat with AI</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Your AI assistant responds 24/7 from anywhere.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
