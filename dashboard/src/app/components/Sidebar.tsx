import React from "react";
import { Settings, Sun, Moon, Plus, History, LayoutGrid, MessageSquare, Plug } from "lucide-react";
import { motion } from "motion/react";

interface SidebarProps {
  theme: "dark" | "light";
  toggleTheme: () => void;
  onOpenSettings: () => void;
  onOpenHistory: () => void;
  onOpenIntegrations: () => void;
  onNewChat: () => void;
}

const NavItem = ({ icon: Icon, label, active = false, theme, onClick }: { 
  icon: any, 
  label: string, 
  active?: boolean, 
  theme: string,
  onClick?: () => void 
}) => {
  const isDark = theme === "dark";
  return (
    <motion.div 
      whileHover={{ scale: 1.1 }}
      whileTap={{ scale: 0.95 }}
      onClick={onClick}
      className="relative group flex items-center justify-center cursor-pointer"
    >
      <div className={`p-2.5 rounded-xl transition-all duration-200 ${
        active 
          ? (isDark ? "bg-[#2dd4bf]/10 text-[#2dd4bf]" : "bg-[#2dd4bf]/10 text-[#0d9488]") 
          : (isDark ? "text-gray-500 hover:bg-white/5 hover:text-gray-300" : "text-gray-400 hover:bg-black/5 hover:text-gray-600")
      }`}>
        <Icon size={22} />
      </div>
      
      {/* Tooltip */}
      <div className={`absolute left-16 px-2 py-1 rounded text-xs font-medium whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 ${
        isDark ? "bg-gray-800 text-gray-200" : "bg-white text-gray-800 shadow-md border border-gray-100"
      }`}>
        {label}
      </div>
    </motion.div>
  );
};

export const Sidebar: React.FC<SidebarProps> = ({ 
  theme, 
  toggleTheme, 
  onOpenSettings,
  onOpenHistory,
  onOpenIntegrations,
  onNewChat
}) => {
  const isDark = theme === "dark";
  
  return (
    <aside
      className={`fixed left-0 top-0 z-50 h-full w-[68px] flex flex-col items-center py-6 transition-colors duration-500 border-r ${
        isDark ? "bg-[#0d0d0d] border-white/5" : "bg-[#fcfcfc] border-black/5"
      }`}
    >
      {/* Top: Logo & New Chat */}
      <div className="flex flex-col items-center gap-8 w-full">
        <motion.div 
          whileHover={{ rotate: 5, scale: 1.05 }}
          className="h-[40px] w-[40px] rounded-xl bg-gradient-to-br from-[#2dd4bf] to-[#0d9488] flex items-center justify-center shadow-[0_0_20px_rgba(45,212,191,0.3)]"
        >
          <span className="text-white font-bold text-xl leading-none">E</span>
        </motion.div>

        <div className="flex flex-col items-center gap-4">
          <NavItem icon={Plus} label="New Chat" active theme={theme} onClick={onNewChat} />
          <NavItem icon={History} label="History" theme={theme} onClick={onOpenHistory} />
          <NavItem icon={MessageSquare} label="Topics" theme={theme} />
          <NavItem icon={Plug} label="Integrations" theme={theme} onClick={onOpenIntegrations} />
        </div>
      </div>

      <div className="flex-1" />

      {/* Bottom: Actions */}
      <div className="flex flex-col items-center gap-4 w-full">
        <motion.button
          onClick={toggleTheme}
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          className={`p-2.5 rounded-xl transition-all ${
            isDark ? "text-gray-500 hover:bg-white/5 hover:text-orange-300" : "text-gray-400 hover:bg-black/5 hover:text-orange-500"
          }`}
          title="Toggle theme"
        >
          {isDark ? <Sun size={20} /> : <Moon size={20} />}
        </motion.button>
        
        <motion.button
          onClick={onOpenSettings}
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          className={`p-2.5 rounded-xl transition-all ${
            isDark ? "text-gray-500 hover:bg-white/5 hover:text-white" : "text-gray-400 hover:bg-black/5 hover:text-black"
          }`}
          title="Settings"
        >
          <Settings size={20} />
        </motion.button>
      </div>
    </aside>
  );
};
