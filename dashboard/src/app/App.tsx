import React, { useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatInterface } from "./components/ChatInterface";
import { Settings } from "./components/Settings";

export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [showSettings, setShowSettings] = useState(false);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  const isDark = theme === "dark";

  return (
    <main
      className={`min-h-screen w-full flex items-center justify-center transition-colors duration-500 ${
        isDark ? "bg-[#0a0a0a]" : "bg-[#fafafa]"
      }`}
    >
      <Sidebar 
        theme={theme} 
        toggleTheme={toggleTheme} 
        onOpenSettings={() => setShowSettings(true)}
      />
      
      <div className="w-full flex justify-center py-20 px-6">
        <ChatInterface theme={theme} />
      </div>

      {/* Settings Modal */}
      <Settings 
        isOpen={showSettings} 
        onClose={() => setShowSettings(false)} 
        theme={theme} 
      />

      {/* Keyboard Shortcut Hint */}
      <div className={`fixed bottom-6 right-6 flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[11px] font-medium tracking-wider transition-opacity duration-500 ${
        isDark ? "bg-white/5 border-white/10 text-gray-500" : "bg-black/5 border-black/5 text-gray-400"
      }`}>
        <span className="flex items-center gap-1"><kbd className="font-sans">⌘</kbd> K</span>
        <span className="opacity-40">SEARCH ANYWHERE</span>
      </div>
    </main>
  );
}
