import { logout } from "../api";

export default function Layout({
  children,
  onLogout,
}: {
  children: React.ReactNode;
  onLogout: () => void;
}) {
  const handleLogout = async () => {
    try {
      await logout();
    } catch {
      /* ignore */
    }
    onLogout();
  };

  const hash = window.location.hash;

  return (
    <div className="flex min-h-screen bg-gray-950 text-gray-100">
      {/* Sidebar */}
      <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="p-4 border-b border-gray-800">
          <h1 className="text-lg font-bold text-white">OpenClaw Hub</h1>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          <a
            href="#/instances"
            className={`block px-3 py-2 rounded text-sm ${
              hash.startsWith("#/instances")
                ? "bg-gray-800 text-white"
                : "text-gray-400 hover:text-white hover:bg-gray-800/50"
            }`}
          >
            Instances
          </a>
          <a
            href="#/events"
            className={`block px-3 py-2 rounded text-sm ${
              hash === "#/events"
                ? "bg-gray-800 text-white"
                : "text-gray-400 hover:text-white hover:bg-gray-800/50"
            }`}
          >
            Events
          </a>
        </nav>
        <div className="p-2 border-t border-gray-800">
          <button
            onClick={handleLogout}
            className="w-full px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800/50 rounded text-left"
          >
            Logout
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 p-6 overflow-auto">{children}</main>
    </div>
  );
}
