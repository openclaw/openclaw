import { NavLink, Route, Routes } from "react-router-dom";
import StatusDashboard from "./pages/StatusDashboard";
import ChatView from "./pages/ChatView";
import OnboardingFlow from "./pages/OnboardingFlow";
import SettingsWindow from "./pages/SettingsWindow";

const navItems = [
  { to: "/", label: "Status", icon: "📊" },
  { to: "/chat", label: "Chat", icon: "💬" },
  { to: "/settings", label: "Settings", icon: "⚙" },
];

export default function App() {
  return (
    <div className="app-shell">
      <nav className="sidebar">
        <div className="sidebar-brand">OpenClaw</div>
        {navItems.map(({ to, label, icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              `sidebar-link${isActive ? " active" : ""}`
            }
          >
            <span className="sidebar-icon">{icon}</span>
            {label}
          </NavLink>
        ))}
      </nav>
      <main className="main-content">
        <Routes>
          <Route path="/" element={<StatusDashboard />} />
          <Route path="/chat" element={<ChatView />} />
          <Route path="/onboarding" element={<OnboardingFlow />} />
          <Route path="/settings" element={<SettingsWindow />} />
        </Routes>
      </main>
    </div>
  );
}
